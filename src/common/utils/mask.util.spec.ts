import { maskEmail, maskPhone, maskPhonesInText } from './mask.util';

describe('maskPhone', () => {
  it('che còn 4 số cuối', () => expect(maskPhone('0912345678')).toBe('******5678'));
  it('null/undefined → null', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });
  it('quá ngắn thì che hết', () => expect(maskPhone('123')).toBe('***'));
});

describe('maskEmail', () => {
  it('giữ ký tự đầu và tên miền', () => expect(maskEmail('an.nguyen@x.vn')).toBe('a***@x.vn'));
  it('null → null', () => expect(maskEmail(null)).toBeNull());
  it('không có @ thì che hết', () => expect(maskEmail('abc')).toBe('***'));
});

describe('maskPhonesInText (L13)', () => {
  it('che SĐT trong URL/chuỗi tự do, giữ 3 số cuối', () => {
    expect(maskPhonesInText('/order?search=0901234567&page=1')).toBe('/order?search=*******567&page=1');
    expect(maskPhonesInText('/customer?phone=%2B84901234567')).toBe('/customer?phone=%2B********567');
    expect(maskPhonesInText('sdt 84901234567 và 0912345678')).toBe('sdt ********567 và *******678');
  });

  it('không đụng số ngắn, mã phiếu, uuid', () => {
    const url = '/order/HD000123?page=2&limit=50&id=3f2a1b4c-0000-4000-8000-123456789012';
    expect(maskPhonesInText(url)).toBe(url);
  });
});
