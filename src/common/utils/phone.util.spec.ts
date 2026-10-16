import { normalizePhoneSearch, normalizeVietnamPhone, VIETNAM_PHONE_PATTERN } from './phone.util';

describe('normalizeVietnamPhone', () => {
  it.each([
    ['0901234567', '0901234567'],
    [' 0901 234 567 ', '0901234567'],
    ['0901.234.567', '0901234567'],
    ['+84901234567', '0901234567'],
    ['+84 901-234-567', '0901234567'],
    ['84901234567', '0901234567'],
    ['(028) 3823 4567', '02838234567'],
    ['+842838234567', '02838234567'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeVietnamPhone(input)).toBe(expected);
    expect(VIETNAM_PHONE_PATTERN.test(expected)).toBe(true);
  });

  it.each(['12345', '090123456', '090123456789', 'abc0901234567', '849012'])(
    '%p không phải SĐT hợp lệ sau chuẩn hoá',
    (input) => {
      expect(VIETNAM_PHONE_PATTERN.test(normalizeVietnamPhone(input))).toBe(false);
    },
  );
});

describe('normalizePhoneSearch', () => {
  it('từ khoá dạng số được chuẩn hoá, kể cả một phần số', () => {
    expect(normalizePhoneSearch('+84 901')).toBe('0901');
    expect(normalizePhoneSearch('901 234')).toBe('901234');
  });

  it('tên và email giữ nguyên, không bỏ khoảng trắng', () => {
    expect(normalizePhoneSearch('Nguyễn Văn A')).toBe('Nguyễn Văn A');
    expect(normalizePhoneSearch('an@mail.com')).toBe('an@mail.com');
  });
});
