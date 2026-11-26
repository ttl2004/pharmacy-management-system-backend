/**
 * Chuẩn hoá tên hãng sản xuất thành "khoá tên" (`nameKey`) để so trùng:
 * "Công ty CP Dược phẩm Trung ương I" và "CTCP DƯỢC PHẨM TRUNG ƯƠNG 1" cùng ra `duoc pham trung uong 1`.
 * Hàm thuần — dùng chung cho service, script backfill và test. Đổi quy tắc ở đây thì phải chạy lại
 * `npm run backfill:manufacturer` để tính lại khoá cho dữ liệu cũ.
 */

/** Bỏ dấu tiếng Việt (và dấu Latin nói chung qua NFD), kể cả đ/Đ → d/D. */
export function stripAccents(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Bỏ dấu, thường hoá, thay mọi ký tự không phải chữ/số bằng khoảng trắng rồi gộp khoảng trắng. */
export function simplifyText(input: string): string {
  return stripAccents(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Cụm/từ pháp nhân tiếng Việt — không bao giờ mang nghĩa phân biệt hãng nên bỏ ở **mọi vị trí**
 * ("Pharbaco - Công ty CP Dược phẩm TW I"). Đã qua `simplifyText`. "cp" chỉ bỏ khi đi liền sau "công ty/cty"
 * vì "CP" đứng riêng có thể là tên hãng ("CP Pharma").
 */
const ANYWHERE_PHRASES: readonly string[][] = [
  ['trach', 'nhiem', 'huu', 'han'],
  ['mot', 'thanh', 'vien'],
  ['cong', 'ty', 'cp'],
  ['cong', 'ty'],
  ['co', 'phan'],
  ['cty', 'cp'],
  ['cty'],
  ['ctcp'],
  ['tnhh'],
  ['mtv'],
  ['jsc'],
];

/**
 * Hậu tố pháp nhân quốc tế ("Co., Ltd" → "co ltd", "S.A." → "s a"). Nhiều từ trong đây ngắn và có thể là một phần
 * tên thật ("BV Pharma", "Dược Cổ truyền", "Sa Đéc", "AG Pharma") → **chỉ bỏ ở cuối tên**, nơi pháp nhân quốc tế
 * luôn đứng. Thà sót (tạo trùng, gộp sau) còn hơn gộp nhầm hai hãng khác nhau.
 */
const TRAILING_PHRASES: readonly string[][] = [
  ['private', 'limited'],
  ['s', 'p', 'a'],
  ['s', 'r', 'l'],
  ['s', 'a'],
  ['b', 'v'],
  ['n', 'v'],
  ...[
    'co',
    'ltd',
    'inc',
    'corp',
    'corporation',
    'limited',
    'gmbh',
    'plc',
    'llc',
    'pvt',
    'pte',
    'sdn',
    'bhd',
    'ag',
    'sa',
    'spa',
    'srl',
    'bv',
    'nv',
    'kg',
    'kft',
    'tbk',
  ].map((word) => [word]),
];

/** Số La Mã đơn lẻ ở cuối tên: "Trung ương I" ≡ "Trung ương 1". */
const TRAILING_ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3' };

function startsWithPhrase(tokens: string[], index: number, phrase: readonly string[]): boolean {
  return phrase.every((word, offset) => tokens[index + offset] === word);
}

/** Cụm dài trước để "cong ty cp" không bị bỏ dở thành "cp". */
const byLengthDesc = (phrases: readonly string[][]) => [...phrases].sort((a, b) => b.length - a.length);
const ANYWHERE_SORTED = byLengthDesc(ANYWHERE_PHRASES);
const TRAILING_SORTED = byLengthDesc(TRAILING_PHRASES);

function removeLegalTerms(tokens: string[]): string[] {
  const kept: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const phrase = ANYWHERE_SORTED.find((p) => startsWithPhrase(tokens, index, p));
    if (phrase) {
      index += phrase.length;
      continue;
    }
    kept.push(tokens[index]);
    index += 1;
  }
  // Bóc dần hậu tố quốc tế ở cuối: "GmbH & Co. KG" → bỏ "kg", "co", "gmbh".
  for (;;) {
    const suffix = TRAILING_SORTED.find(
      (p) => p.length <= kept.length && startsWithPhrase(kept, kept.length - p.length, p),
    );
    if (!suffix) return kept;
    kept.length -= suffix.length;
  }
}

/**
 * Khoá tên hãng: bỏ dấu, thường hoá, bỏ dấu câu, bỏ cụm pháp nhân (tiếng Việt: mọi vị trí; hậu tố quốc tế: chỉ ở cuối;
 * luôn chỉ khi là từ đứng riêng),
 * đổi I/II/III cuối tên thành 1/2/3. Nếu bỏ hết thì rơi về bản chỉ bỏ dấu (tên "Công ty TNHH" vẫn có khoá).
 * Trả chuỗi rỗng chỉ khi tên không có chữ/số nào.
 */
export function normalizeManufacturerName(name: string): string {
  const simplified = simplifyText(name);
  if (!simplified) return '';

  const tokens = removeLegalTerms(simplified.split(' '));
  if (tokens.length === 0) return simplified;

  const last = tokens.length - 1;
  if (last > 0 && TRAILING_ROMAN[tokens[last]]) tokens[last] = TRAILING_ROMAN[tokens[last]];
  return tokens.join(' ');
}
