import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { createReadStream } from 'fs';
import { join, resolve } from 'path';

/*
 * import:interaction-data — nạp 4 file CSV tương tác thuốc (DDInter) vào 4 bảng CHỈ ĐỌC trong Postgres.
 * Dùng: npm run import:interaction-data -- <thư-mục-CSV> --yes   (hoặc env INTERACTION_DATA_DIR thay cho thư mục)
 * - Không có `--yes` thì chỉ in DB đích (host + tên DB) rồi dừng, không ghi gì.
 * - Cả 4 bảng được thay trong MỘT transaction (DELETE rồi createMany theo lô): lỗi giữa chừng thì cả 4 giữ nguyên
 *   bản cũ, người đọc không bao giờ thấy dữ liệu nạp dở hoặc lẫn hai phiên bản.
 * - Không dùng TRUNCATE (khoá độc quyền chặn người đọc). Chạy lại an toàn. Chỉ đụng đúng 4 bảng này.
 * - Sau khi commit chạy ANALYZE 4 bảng để planner có thống kê mới. DELETE để lại dòng chết: nạp lại nhiều lần thì
 *   nên `VACUUM (ANALYZE)` 4 bảng lúc vắng người (autovacuum cũng sẽ dọn dần).
 */

const TX_TIMEOUT_MS = 30 * 60 * 1000;
/** Postgres tối đa 32767 tham số mỗi câu lệnh → lô = min(5000, 30000 / số cột). */
const MAX_PARAMS = 30000;
const MAX_BATCH = 5000;

// ---------------------------------------------------------------------------------------------
// Phân tích CSV (RFC 4180): ngoặc kép, dấu phẩy/xuống dòng trong ô, "" thoát ngoặc, BOM đầu file.
// ---------------------------------------------------------------------------------------------

/** Bộ phân tích CSV theo dòng chữ, nhận từng đoạn (chunk) để không phải đọc cả file 200MB vào một chuỗi. */
export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** Vừa gặp dấu `"` trong ô có ngoặc: có thể là đóng ô hoặc nửa đầu của `""`. */
  private pendingQuote = false;
  private pendingCr = false;
  private started = false;
  private fieldStarted = false;

  constructor(private readonly onRow: (row: string[]) => void) {}

  push(chunk: string): void {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    // Gom ký tự thường theo đoạn [segStart, i) rồi cắt một lần — cộng từng ký tự sẽ tạo chuỗi rope làm tràn bộ nhớ.
    let segStart = -1;
    const flush = (end: number): void => {
      if (segStart >= 0) {
        this.field += text.slice(segStart, end);
        segStart = -1;
      }
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false; // dấu " trước đó đã đóng ô; xử lý ký tự hiện tại như ngoài ngoặc
      }
      if (this.inQuotes) {
        if (ch === '"') {
          flush(i);
          this.pendingQuote = true;
        } else if (segStart < 0) segStart = i;
        continue;
      }
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === '\n') continue; // \r\n đã kết thúc dòng ở \r
      }
      if (ch === '"' && !this.fieldStarted && segStart < 0) {
        this.inQuotes = true;
        this.fieldStarted = true;
      } else if (ch === ',') {
        flush(i);
        this.endField();
      } else if (ch === '\n') {
        flush(i);
        this.endRow();
      } else if (ch === '\r') {
        flush(i);
        this.endRow();
        this.pendingCr = true;
      } else {
        if (segStart < 0) segStart = i;
        this.fieldStarted = true;
      }
    }
    flush(text.length);
  }

  /** Gọi khi hết dữ liệu; đẩy dòng cuối nếu file không kết thúc bằng xuống dòng. */
  end(): void {
    if (this.inQuotes && !this.pendingQuote) throw new Error('CSV bị cắt giữa chừng: có ô mở ngoặc kép mà không đóng');
    this.pendingQuote = false;
    this.inQuotes = false;
    if (this.fieldStarted || this.field !== '' || this.row.length > 0) this.endRow();
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.fieldStarted = false;
  }

  private endRow(): void {
    // Dòng trống hoàn toàn (không có ô nào) thì bỏ qua
    if (this.row.length === 0 && !this.fieldStarted && this.field === '') return;
    this.endField();
    const row = this.row;
    this.row = [];
    this.onRow(row);
  }
}

/** Phân tích cả chuỗi CSV thành mảng dòng (dùng cho test / file nhỏ). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser((r) => rows.push(r));
  parser.push(text);
  parser.end();
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Chuyển đổi giá trị ô
// ---------------------------------------------------------------------------------------------

/** Ô trống → null; cột nội dung chữ: "None" và "-" cũng là rỗng (như clean_text của TTT-BE). */
export function toText(value: string | undefined, treatPlaceholderAsEmpty = false): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (treatPlaceholderAsEmpty && (trimmed === 'None' || trimmed === '-')) return null;
  return value;
}

/** Cột mã/khoá: cắt khoảng trắng; ô trống → null. */
export function toKey(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function toInt(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) throw new Error(`Không phải số nguyên: "${value}"`);
  return n;
}

export function toFloat(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new Error(`Không phải số: "${value}"`);
  return n;
}

export function toBool(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Không phải True/False: "${value}"`);
}

function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`Cột bắt buộc "${column}" bị trống`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Định nghĩa 4 bảng
// ---------------------------------------------------------------------------------------------

type Row = Record<string, string>;

interface TableSpec {
  file: string;
  table: string;
  headers: string[];
  /** Số cột của bảng, để tính cỡ lô. */
  columnCount: number;
  /** Chèn một lô dòng đã chuyển đổi (cột Prisma camelCase). */
  insert: (tx: Prisma.TransactionClient, rows: Row[]) => Promise<void>;
  clear: (tx: Prisma.TransactionClient) => Promise<unknown>;
}

export const TABLES: TableSpec[] = [
  {
    file: 'ddinter_interactions_final.csv',
    table: 'ddinter_interactions_final',
    headers: ['InteractionID', 'DDInterID_A', 'Drug_A', 'DDInterID_B', 'Drug_B', 'Level', 'Interaction', 'Management'],
    columnCount: 8,
    clear: (tx) => tx.ddinterInteraction.deleteMany(),
    insert: async (tx, rows) => {
      await tx.ddinterInteraction.createMany({
        data: rows.map((r) => ({
          id: required(toInt(r.InteractionID), 'InteractionID'),
          ddinterIdA: required(toKey(r.DDInterID_A), 'DDInterID_A'),
          drugA: required(toText(r.Drug_A), 'Drug_A'),
          ddinterIdB: required(toKey(r.DDInterID_B), 'DDInterID_B'),
          drugB: required(toText(r.Drug_B), 'Drug_B'),
          level: required(toKey(r.Level), 'Level'),
          interaction: toText(r.Interaction, true),
          management: toText(r.Management, true),
        })),
      });
    },
  },
  {
    file: 'drug_disease_interactions.csv',
    table: 'drug_disease_interactions',
    headers: ['id', 'drug_id', 'drug_name', 'level', 'severity', 'disease_name', 'description', 'references'],
    columnCount: 8,
    clear: (tx) => tx.drugDiseaseInteraction.deleteMany(),
    insert: async (tx, rows) => {
      await tx.drugDiseaseInteraction.createMany({
        data: rows.map((r) => ({
          id: required(toInt(r.id), 'id'),
          drugId: required(toKey(r.drug_id), 'drug_id'),
          drugName: required(toText(r.drug_name), 'drug_name'),
          level: toInt(r.level),
          severity: required(toKey(r.severity), 'severity'),
          diseaseName: required(toText(r.disease_name), 'disease_name'),
          description: toText(r.description, true),
          references: toText(r.references),
        })),
      });
    },
  },
  {
    file: 'drug_food_interactions.csv',
    table: 'drug_food_interactions',
    headers: [
      'id',
      'drug_id',
      'drug_name',
      'level',
      'severity',
      'food_name',
      'description',
      'management',
      'mechanism',
      'references',
    ],
    columnCount: 10,
    clear: (tx) => tx.drugFoodInteraction.deleteMany(),
    insert: async (tx, rows) => {
      await tx.drugFoodInteraction.createMany({
        data: rows.map((r) => ({
          id: required(toInt(r.id), 'id'),
          drugId: required(toKey(r.drug_id), 'drug_id'),
          drugName: required(toText(r.drug_name), 'drug_name'),
          level: toInt(r.level),
          severity: required(toKey(r.severity), 'severity'),
          foodName: required(toText(r.food_name), 'food_name'),
          description: toText(r.description, true),
          management: toText(r.management, true),
          mechanism: toText(r.mechanism, true),
          references: toText(r.references),
        })),
      });
    },
  },
  {
    file: 'national-drug-ddinter-mapping.csv',
    table: 'national_drug_ddinter_mapping',
    headers: [
      'registration_number',
      'drug_name',
      'drug_group',
      'inferred_route',
      'ingredient_text_raw',
      'ingredient_order',
      'ingredient_name',
      'ingredient_alternates',
      'match_method',
      'ddinter_id',
      'ddinter_drug',
      'confidence',
      'needs_review',
      'suggested_ddinter_id',
      'suggested_ddinter_drug',
      'suggested_score',
    ],
    columnCount: 16,
    clear: (tx) => tx.nationalDrugDdinterMapping.deleteMany(),
    insert: async (tx, rows) => {
      await tx.nationalDrugDdinterMapping.createMany({
        data: rows.map((r) => ({
          registrationNumber: required(toKey(r.registration_number), 'registration_number'),
          drugName: required(toText(r.drug_name), 'drug_name'),
          drugGroup: required(toKey(r.drug_group), 'drug_group'),
          inferredRoute: toKey(r.inferred_route),
          ingredientTextRaw: toText(r.ingredient_text_raw),
          ingredientOrder: required(toInt(r.ingredient_order), 'ingredient_order'),
          ingredientName: toText(r.ingredient_name),
          ingredientAlternates: toText(r.ingredient_alternates),
          matchMethod: required(toKey(r.match_method), 'match_method'),
          ddinterId: toKey(r.ddinter_id),
          ddinterDrug: toText(r.ddinter_drug),
          confidence: toFloat(r.confidence),
          needsReview: toBool(r.needs_review),
          suggestedDdinterId: toKey(r.suggested_ddinter_id),
          suggestedDdinterDrug: toText(r.suggested_ddinter_drug),
          suggestedScore: toFloat(r.suggested_score),
        })),
      });
    },
  },
];

/** Trả về tên các header bắt buộc còn thiếu. */
export function missingHeaders(actual: string[], expected: string[]): string[] {
  const have = new Set(actual.map((h) => h.trim()));
  return expected.filter((h) => !have.has(h));
}

/** Ghép dòng thành object theo header; dòng ngắn/dài hơn header là lỗi dữ liệu. */
export function rowToObject(headers: string[], cells: string[], lineNo: number): Row {
  if (cells.length !== headers.length) {
    throw new Error(`Dòng dữ liệu thứ ${lineNo}: có ${cells.length} ô nhưng header có ${headers.length} cột`);
  }
  const obj: Row = {};
  headers.forEach((h, i) => (obj[h] = cells[i]));
  return obj;
}

/** Đọc header (dòng đầu) của file và kiểm tra đủ cột bắt buộc — làm cho cả 4 file trước khi đụng DB. */
async function checkHeaders(path: string, spec: TableSpec): Promise<void> {
  let header: string[] | null = null;
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const parser = new CsvParser((cells) => {
    header ??= cells.map((h) => h.trim());
  });
  for await (const chunk of stream) {
    parser.push(chunk as string);
    if (header) break;
  }
  stream.destroy();
  if (!header) throw new Error(`File ${spec.file} rỗng`);
  const missing = missingHeaders(header, spec.headers);
  if (missing.length > 0) throw new Error(`File ${spec.file} thiếu các cột bắt buộc: ${missing.join(', ')}`);
}

/** Đọc file CSV theo luồng, gom lô và gọi `onBatch` (tuần tự). Trả về tổng số dòng dữ liệu. */
async function streamCsv(path: string, batchSize: number, onBatch: (rows: Row[]) => Promise<void>): Promise<number> {
  let headers: string[] | null = null;
  let batch: Row[] = [];
  let total = 0;
  const parser = new CsvParser((cells) => {
    if (!headers) {
      headers = cells.map((h) => h.trim());
      return;
    }
    total += 1;
    batch.push(rowToObject(headers, cells, total));
  });
  const drain = async (all: boolean): Promise<void> => {
    while (batch.length >= batchSize || (all && batch.length > 0)) {
      const rows = batch.slice(0, batchSize);
      batch = batch.slice(batchSize);
      await onBatch(rows);
    }
  };
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    parser.push(chunk as string);
    await drain(false);
  }
  parser.end();
  await drain(true);
  return total;
}

export interface ImportArgs {
  dir: string;
  confirmed: boolean;
}

/** Thư mục CSV: tham số dòng lệnh hoặc INTERACTION_DATA_DIR (bắt buộc một trong hai). `--yes` mới được ghi. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ImportArgs {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--yes');
  if (unknown.length) throw new Error(`Tham số không hỗ trợ: ${unknown.join(' ')}`);
  if (positional.length > 1) throw new Error('Chỉ nhận một thư mục CSV');
  const dir = positional[0] ?? env.INTERACTION_DATA_DIR;
  if (!dir) {
    throw new Error(
      'Thiếu thư mục CSV: npm run import:interaction-data -- <thư-mục-CSV> --yes (hoặc đặt INTERACTION_DATA_DIR)',
    );
  }
  return { dir: resolve(dir), confirmed: argv.includes('--yes') };
}

/** "host:port/database" của DATABASE_URL — không bao giờ in mật khẩu. */
export function describeTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('DATABASE_URL chưa được cấu hình');
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema');
  return `${url.hostname}${url.port ? `:${url.port}` : ''}/${url.pathname.replace(/^\//, '')}${schema ? ` (schema ${schema})` : ''}`;
}

async function main(): Promise<void> {
  const { dir, confirmed } = parseArgs(process.argv.slice(2), process.env);
  console.log(`Thư mục CSV: ${dir}`);
  console.log(`DB đích:     ${describeTarget(process.env.DATABASE_URL)}`);

  // Kiểm tra header của TẤT CẢ file trước khi đụng DB.
  for (const spec of TABLES) await checkHeaders(join(dir, spec.file), spec);
  if (!confirmed) {
    console.log('Chưa ghi gì. Kiểm tra lại DB đích ở trên rồi chạy lại kèm --yes để nạp.');
    return;
  }

  const startedAll = Date.now();
  const prisma = new PrismaClient();
  try {
    // MỘT transaction cho cả 4 bảng: lỗi dữ liệu ở bảng nào thì cả 4 cùng giữ bản cũ.
    await prisma.$transaction(
      async (tx) => {
        for (const spec of TABLES) {
          const started = Date.now();
          const batchSize = Math.min(MAX_BATCH, Math.floor(MAX_PARAMS / spec.columnCount));
          const removed = (await spec.clear(tx)) as { count: number };
          const count = await streamCsv(join(dir, spec.file), batchSize, (rows) => spec.insert(tx, rows));
          if (count === 0) throw new Error(`File ${spec.file} không có dòng dữ liệu nào — giữ nguyên dữ liệu cũ`);
          console.log(`  ${spec.table}: xoá ${removed.count} dòng cũ, nạp ${count} dòng (${Date.now() - started}ms)`);
        }
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 60_000 },
    );
    console.log('Đã commit cả 4 bảng.');
    // Tên bảng là hằng số trong TABLES, không phải dữ liệu nhập.
    for (const spec of TABLES) await prisma.$executeRawUnsafe(`ANALYZE "${spec.table}"`);
    console.log('Đã ANALYZE 4 bảng. Nạp lại nhiều lần thì nên VACUUM (ANALYZE) 4 bảng này lúc vắng người.');
  } finally {
    await prisma.$disconnect();
  }
  console.log(`Xong sau ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Nạp dữ liệu tương tác thuốc thất bại:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
