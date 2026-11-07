import { foldVn } from './vn-fold.util';

describe('foldVn', () => {
  it('bỏ dấu và chuyển chữ thường', () => {
    expect(foldVn('Thuốc HẾT hạn')).toBe('thuoc het han');
  });

  it('huỷ và hủy (hai cách đặt dấu) cho cùng kết quả', () => {
    expect(foldVn('huỷ')).toBe(foldVn('hủy'));
  });

  it('đổi Đ thành d, gộp khoảng trắng và trim', () => {
    expect(foldVn('Đơn  PN000123 ')).toBe('don pn000123');
  });

  it('null và undefined trả chuỗi rỗng', () => {
    expect(foldVn(null)).toBe('');
    expect(foldVn(undefined)).toBe('');
  });

  it('chuỗi NFD cho cùng kết quả với NFC', () => {
    expect(foldVn('Nguyễn Văn Đức'.normalize('NFD'))).toBe('nguyen van duc');
  });
});
