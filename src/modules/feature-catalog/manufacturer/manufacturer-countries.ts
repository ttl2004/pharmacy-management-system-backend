import { simplifyText } from './manufacturer-name';

/**
 * Danh sách quốc gia chuẩn (tên tiếng Việt) cho hãng sản xuất — FE dùng làm ô chọn.
 * "Việt Nam" đứng đầu vì là lựa chọn phổ biến nhất, phần còn lại theo bảng chữ cái tiếng Việt.
 */
const OTHER_COUNTRIES = [
  'Ai Cập',
  'Ireland',
  'Anh',
  'Áo',
  'Argentina',
  'Ấn Độ',
  'Ba Lan',
  'Bangladesh',
  'Bỉ',
  'Bồ Đào Nha',
  'Brazil',
  'Bulgaria',
  'Canada',
  'Chile',
  'Colombia',
  'Croatia',
  'Cuba',
  'Cyprus',
  'Đài Loan',
  'Đan Mạch',
  'Đức',
  'Hà Lan',
  'Hàn Quốc',
  'Hồng Kông',
  'Hungary',
  'Hy Lạp',
  'Indonesia',
  'Iran',
  'Israel',
  'Jordan',
  'Lào',
  'Latvia',
  'Litva',
  'Malaysia',
  'Malta',
  'Mexico',
  'Mỹ',
  'Na Uy',
  'Nam Phi',
  'Nga',
  'Nhật Bản',
  'Pakistan',
  'Pháp',
  'Phần Lan',
  'Philippines',
  'Romania',
  'Séc',
  'Serbia',
  'Singapore',
  'Slovakia',
  'Slovenia',
  'Sri Lanka',
  'Tây Ban Nha',
  'Thái Lan',
  'Thổ Nhĩ Kỳ',
  'Thuỵ Điển',
  'Thuỵ Sĩ',
  'Trung Quốc',
  'Úc',
  'Ukraine',
  'Ý',
  'Belarus',
  'Campuchia',
  'Estonia',
  'Iceland',
  'Luxembourg',
  'New Zealand',
  'Ả Rập Xê Út',
  'Các Tiểu vương quốc Ả Rập Thống nhất',
].sort((a, b) => a.localeCompare(b, 'vi'));

export const MANUFACTURER_COUNTRIES: readonly string[] = Object.freeze(['Việt Nam', ...OTHER_COUNTRIES]);

/**
 * Bí danh → tên chuẩn. Khoá được so sau `simplifyText` (bỏ dấu, thường hoá, bỏ dấu câu) nên
 * "VIỆT NAM", "viet-nam", "Việt nam" đều khớp mà không cần liệt kê. Tên chuẩn tự là bí danh của chính nó.
 */
export const COUNTRY_ALIASES: Record<string, readonly string[]> = {
  'Việt Nam': ['VN', 'VNM', 'Viet Nam', 'Vietnam', 'Viet-nam', 'Socialist Republic of Vietnam'],
  'Ấn Độ': ['India', 'IN', 'IND', 'An Do'],
  'Trung Quốc': ['China', 'CN', 'CHN', 'PRC', "People's Republic of China", 'Trung Hoa'],
  'Hàn Quốc': [
    'Korea',
    'South Korea',
    'Republic of Korea',
    'Korea, Republic of',
    'Korea (South)',
    'KR',
    'KOR',
    'Nam Hàn',
  ],
  'Nhật Bản': ['Japan', 'JP', 'JPN', 'Nhật'],
  Pháp: ['France', 'FR', 'FRA'],
  Đức: ['Germany', 'DE', 'DEU', 'Deutschland'],
  Anh: ['UK', 'U.K.', 'GB', 'GBR', 'United Kingdom', 'England', 'Great Britain', 'Britain', 'Vương quốc Anh'],
  Mỹ: ['USA', 'US', 'U.S.', 'U.S.A.', 'United States', 'United States of America', 'America', 'Hoa Kỳ', 'Hoa Ky'],
  Ý: ['Italy', 'IT', 'ITA', 'Italia'],
  'Tây Ban Nha': ['Spain', 'ES', 'ESP', 'España'],
  'Thuỵ Sĩ': ['Switzerland', 'CH', 'CHE', 'Swiss', 'Thụy Sỹ', 'Thuỵ Sỹ'],
  Bỉ: ['Belgium', 'BE', 'BEL'],
  'Hà Lan': ['Netherlands', 'The Netherlands', 'Holland', 'NL', 'NLD'],
  Áo: ['Austria', 'AT', 'AUT'],
  'Ba Lan': ['Poland', 'PL', 'POL'],
  Hungary: ['HU', 'HUN', 'Hungari', 'Hung-ga-ri'],
  Séc: ['Czech', 'Czech Republic', 'Czechia', 'CZ', 'CZE', 'Cộng hoà Séc', 'Cộng hòa Séc', 'CH Séc'],
  Slovenia: ['SI', 'SVN', 'Xlô-ven-ni-a'],
  'Thái Lan': ['Thailand', 'TH', 'THA'],
  Indonesia: ['ID', 'IDN', 'In-đô-nê-xi-a'],
  // Không nhận mã ISO "MY" của Malaysia: trùng "Mỹ" sau khi bỏ dấu.
  Malaysia: ['MYS', 'Ma-lai-xi-a', 'Malaixia'],
  Singapore: ['SG', 'SGP', 'Xin-ga-po', 'Singapo'],
  Pakistan: ['PK', 'PAK'],
  Bangladesh: ['BD', 'BGD', 'Băng-la-đét', 'Bangladet'],
  Úc: ['Australia', 'AU', 'AUS', 'Ô-xtrây-li-a'],
  Canada: ['CA', 'CAN', 'Ca-na-đa'],
  Argentina: ['AR', 'ARG', 'Ác-hen-ti-na'],
  Brazil: ['BR', 'BRA', 'Brasil', 'Bra-xin'],
  'Thổ Nhĩ Kỳ': ['Turkey', 'Türkiye', 'Turkiye', 'TR', 'TUR'],
  Israel: ['IL', 'ISR', 'I-xra-en'],
  'Đài Loan': ['Taiwan', 'TW', 'TWN', 'Taiwan, Province of China', 'Chinese Taipei'],
  'Hy Lạp': ['Greece', 'GR', 'GRC'],
  'Bồ Đào Nha': ['Portugal', 'PT', 'PRT'],
  'Thuỵ Điển': ['Sweden', 'SE', 'SWE', 'Thụy Điển'],
  'Đan Mạch': ['Denmark', 'DK', 'DNK'],
  Ireland: ['IE', 'IRL', 'Ai-len', 'Ai Len', 'Ailen'],
  Nga: ['Russia', 'Russian Federation', 'RU', 'RUS', 'Liên bang Nga'],
  'Ai Cập': ['Egypt', 'EG', 'EGY'],
  Cyprus: ['CY', 'CYP', 'Síp', 'Sip'],
  Romania: ['RO', 'ROU', 'Rumani', 'Ru-ma-ni'],
  Bulgaria: ['BG', 'BGR', 'Bungari', 'Bun-ga-ri'],
  Croatia: ['HR', 'HRV', 'Crô-a-ti-a'],
  Slovakia: ['SK', 'SVK', 'Xlô-va-ki-a'],
  'Phần Lan': ['Finland', 'FI', 'FIN'],
  'Na Uy': ['Norway', 'NO', 'NOR'],
  'Hồng Kông': ['Hong Kong', 'HK', 'HKG', 'Hongkong'],
  Philippines: ['PH', 'PHL', 'Phi-líp-pin', 'Philippin'],
  'Nam Phi': ['South Africa', 'ZA', 'ZAF'],
  Mexico: ['MX', 'MEX', 'Mê-hi-cô'],
  'New Zealand': ['NZ', 'NZL', 'Niu Di-lân'],
  'Sri Lanka': ['LK', 'LKA'],
  'Ả Rập Xê Út': ['Saudi Arabia', 'SA', 'SAU'],
  'Các Tiểu vương quốc Ả Rập Thống nhất': ['United Arab Emirates', 'UAE', 'AE', 'ARE'],
  Ukraine: ['UA', 'UKR', 'U-crai-na'],
  Belarus: ['BY', 'BLR', 'Bê-la-rút'],
  Iran: ['IR', 'IRN'],
  Jordan: ['JO', 'JOR', 'Gioóc-đa-ni'],
  Lào: ['Laos', 'LA', 'LAO'],
  Campuchia: ['Cambodia', 'KH', 'KHM'],
  Cuba: ['CU', 'CUB'],
  Chile: ['CL', 'CHL', 'Chi-lê'],
  Colombia: ['CO', 'COL', 'Cô-lôm-bi-a'],
  Latvia: ['LV', 'LVA'],
  Litva: ['Lithuania', 'LT', 'LTU'],
  Estonia: ['EE', 'EST'],
  Malta: ['MT', 'MLT'],
  Luxembourg: ['LU', 'LUX', 'Lúc-xăm-bua'],
  Iceland: ['IS', 'ISL', 'Ai-xơ-len', 'Băng Đảo'],
  Serbia: ['RS', 'SRB', 'Xéc-bi-a'],
};

const CANONICAL_BY_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const name of MANUFACTURER_COUNTRIES) map.set(simplifyText(name), name);
  for (const [name, aliases] of Object.entries(COUNTRY_ALIASES)) {
    for (const alias of aliases) {
      const key = simplifyText(alias);
      const taken = map.get(key);
      // Bí danh trùng (sau bỏ dấu) với nước khác là lỗi dữ liệu hằng — báo ngay lúc nạp module, không âm thầm ghi đè.
      if (taken !== undefined && taken !== name) throw new Error(`Bí danh quốc gia "${alias}" trùng với ${taken}`);
      map.set(key, name);
    }
  }
  return map;
})();

/** Tên quốc gia chuẩn nếu nhận ra (`VN`, `Viet Nam`, `USA`…), ngược lại trả nguyên văn đã trim. */
export function canonicalCountry(input: string): string {
  const trimmed = input.trim();
  return CANONICAL_BY_KEY.get(simplifyText(trimmed)) ?? trimmed;
}

/** Như `canonicalCountry` nhưng giữ null/undefined, và chuỗi rỗng → null (không lưu quốc gia rỗng). */
export function canonicalCountryOrNull(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = canonicalCountry(input);
  return value === '' ? null : value;
}
