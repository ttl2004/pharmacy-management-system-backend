import {
  COUNTRY_ALIASES,
  MANUFACTURER_COUNTRIES,
  canonicalCountry,
  canonicalCountryOrNull,
} from './manufacturer-countries';
import { simplifyText } from './manufacturer-name';

describe('MANUFACTURER_COUNTRIES', () => {
  it('Việt Nam đứng đầu, không trùng (kể cả sau khi bỏ dấu)', () => {
    expect(MANUFACTURER_COUNTRIES[0]).toBe('Việt Nam');
    const keys = MANUFACTURER_COUNTRIES.map(simplifyText);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('đủ các nước sản xuất thuốc thường gặp', () => {
    for (const name of [
      'Ấn Độ',
      'Trung Quốc',
      'Hàn Quốc',
      'Nhật Bản',
      'Pháp',
      'Đức',
      'Anh',
      'Mỹ',
      'Ý',
      'Tây Ban Nha',
      'Thuỵ Sĩ',
      'Bỉ',
      'Hà Lan',
      'Áo',
      'Ba Lan',
      'Hungary',
      'Séc',
      'Slovenia',
      'Thái Lan',
      'Indonesia',
      'Malaysia',
      'Singapore',
      'Pakistan',
      'Bangladesh',
      'Úc',
      'Canada',
      'Argentina',
      'Brazil',
      'Thổ Nhĩ Kỳ',
      'Israel',
      'Đài Loan',
      'Hy Lạp',
      'Bồ Đào Nha',
      'Thuỵ Điển',
      'Đan Mạch',
      'Ireland',
      'Nga',
      'Ai Cập',
      'Cyprus',
      'Romania',
      'Bulgaria',
      'Croatia',
      'Slovakia',
      'Phần Lan',
      'Na Uy',
    ]) {
      expect(MANUFACTURER_COUNTRIES).toContain(name);
    }
  });

  it('mọi bí danh trỏ về một tên có trong danh sách và ánh xạ đúng về tên đó', () => {
    for (const [name, aliases] of Object.entries(COUNTRY_ALIASES)) {
      expect(MANUFACTURER_COUNTRIES).toContain(name);
      for (const alias of aliases) expect(canonicalCountry(alias)).toBe(name);
    }
  });

  it('mỗi tên chuẩn tự ánh xạ về chính nó', () => {
    for (const name of MANUFACTURER_COUNTRIES) expect(canonicalCountry(name)).toBe(name);
  });
});

describe('canonicalCountry', () => {
  it.each([
    ['VN', 'Việt Nam'],
    ['vn', 'Việt Nam'],
    ['Viet Nam', 'Việt Nam'],
    ['Vietnam', 'Việt Nam'],
    ['VIỆT NAM', 'Việt Nam'],
    ['  việt nam  ', 'Việt Nam'],
    ['USA', 'Mỹ'],
    ['US', 'Mỹ'],
    ['U.S.A.', 'Mỹ'],
    ['Hoa Kỳ', 'Mỹ'],
    ['United States', 'Mỹ'],
    ['UK', 'Anh'],
    ['England', 'Anh'],
    ['United Kingdom', 'Anh'],
    ['India', 'Ấn Độ'],
    ['An Do', 'Ấn Độ'],
    ['China', 'Trung Quốc'],
    ['Korea', 'Hàn Quốc'],
    ['Korea, Republic of', 'Hàn Quốc'],
    ['Japan', 'Nhật Bản'],
    ['France', 'Pháp'],
    ['Germany', 'Đức'],
    ['Italy', 'Ý'],
    ['Spain', 'Tây Ban Nha'],
    ['Switzerland', 'Thuỵ Sĩ'],
    ['Thụy Sĩ', 'Thuỵ Sĩ'],
    ['Thụy Sỹ', 'Thuỵ Sĩ'],
    ['Czech Republic', 'Séc'],
    ['Cộng hòa Séc', 'Séc'],
    ['Taiwan', 'Đài Loan'],
    ['Turkey', 'Thổ Nhĩ Kỳ'],
    ['Russia', 'Nga'],
    ['Ireland', 'Ireland'],
    ['Ai-len', 'Ireland'],
    ['Iceland', 'Iceland'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalCountry(input)).toBe(expected);
  });

  it('không nhận ra thì giữ nguyên văn đã trim', () => {
    expect(canonicalCountry('  Xứ Wakanda ')).toBe('Xứ Wakanda');
    expect(canonicalCountry('')).toBe('');
  });
});

describe('canonicalCountryOrNull', () => {
  it('giữ null, chuỗi rỗng/khoảng trắng → null, còn lại chuẩn hoá', () => {
    expect(canonicalCountryOrNull(null)).toBeNull();
    expect(canonicalCountryOrNull(undefined)).toBeNull();
    expect(canonicalCountryOrNull('   ')).toBeNull();
    expect(canonicalCountryOrNull('VN')).toBe('Việt Nam');
  });
});
