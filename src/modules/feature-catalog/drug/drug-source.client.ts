import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

/** Chuỗi có thể rỗng phía nguồn (thiếu khoá = null); độ dài tối đa theo cột tương ứng của bảng `drugs`. */
const optionalText = (max?: number) => (max ? z.string().max(max) : z.string()).nullable().default(null);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

/** Một thuốc như nguồn CSDL Dược trả về — đủ 21 cột gốc. Khoá lạ khác bị bỏ qua (không strict). */
const drugSourceRecordSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(250),
  drugGroup: optionalText(100),
  controlType: optionalText(100),
  isPrescription: z.boolean(),
  registrationNumber: optionalText(50),
  registeredAt: isoDate,
  registrationExpiresAt: isoDate,
  strength: optionalText(100),
  ingredients: optionalText(),
  manufacturerName: optionalText(250),
  countryOfOrigin: optionalText(100),
  packagingSpec: optionalText(250),
  route: optionalText(100),
  indications: optionalText(),
  contraindications: optionalText(),
  storage: optionalText(),
  effects: optionalText(),
  sideEffects: optionalText(),
  warnings: optionalText(),
  dosage: optionalText(),
});

const drugSourcePageSchema = z.object({
  items: z.array(drugSourceRecordSchema),
  total: z.number().int().nonnegative(),
});

export type DrugSourceRecord = z.infer<typeof drugSourceRecordSchema>;

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/** Đọc toàn bộ danh mục thuốc từ nguồn ngoài (hiện là API giả lập ở repo CSDL-Drug). */
@Injectable()
export class DrugSourceClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('DRUG_SOURCE_URL');
  }

  /**
   * Tải đủ mọi trang. Bất kỳ dấu hiệu danh mục không trọn vẹn nào (trang rỗng giữa chừng, `total` đổi giữa các trang,
   * mã trùng) đều báo lỗi — sau bước này mọi mã vắng mặt sẽ bị chuyển INACTIVE, nên thà huỷ còn hơn ghi danh mục thiếu.
   */
  async fetchAll(): Promise<DrugSourceRecord[]> {
    const first = await this.fetchPage(1);
    const drugs = [...first.items];
    for (let page = 2; drugs.length < first.total; page++) {
      const { items, total } = await this.fetchPage(page);
      if (total !== first.total) throw this.unavailable('Nguồn CSDL Dược đổi tổng số thuốc giữa các trang');
      if (!items.length) throw this.unavailable('Nguồn CSDL Dược trả thiếu trang so với tổng số thuốc');
      drugs.push(...items);
    }
    if (drugs.length !== first.total) throw this.unavailable('Số thuốc nhận được không khớp tổng nguồn báo');

    const codes = new Set(drugs.map((drug) => drug.code));
    if (codes.size !== drugs.length) throw this.unavailable('Nguồn CSDL Dược trả mã thuốc trùng');
    return drugs;
  }

  private async fetchPage(page: number) {
    const url = new URL('/api/v1/drugs', this.baseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));

    let body: unknown;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw this.unavailable(`Nguồn CSDL Dược trả lỗi HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof ErrorException) throw error;
      throw this.unavailable(`Không đọc được nguồn CSDL Dược (${this.baseUrl})`);
    }

    const parsed = drugSourcePageSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw this.unavailable(`Dữ liệu nguồn CSDL Dược sai định dạng tại ${issue.path.join('.')}: ${issue.message}`);
    }
    return parsed.data;
  }

  private unavailable(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.DRUG_SOURCE_UNAVAILABLE, message });
  }
}
