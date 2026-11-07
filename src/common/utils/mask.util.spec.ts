import { maskEmail, maskPhone } from './mask.util';

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
