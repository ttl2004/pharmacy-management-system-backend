import { serializeTimestamps } from './date.util';

describe('serializeTimestamps — kiểu dữ liệu của kho', () => {
  it('BigInt (tổng tiền phiếu nhập) thành number để JSON.stringify không ném lỗi', () => {
    const result = serializeTimestamps({ totalAmount: 2_500_000_000n, lines: [{ totalPrice: 7n }] });

    expect(result).toEqual({ totalAmount: 2_500_000_000, lines: [{ totalPrice: 7 }] });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('BigInt vượt số nguyên an toàn thì thành chuỗi, không âm thầm làm tròn', () => {
    expect(serializeTimestamps({ totalAmount: 9_007_199_254_740_993n })).toEqual({
      totalAmount: '9007199254740993',
    });
  });

  it('cột ngày không giờ trả YYYY-MM-DD', () => {
    const expiryDate = new Date('2027-01-31T00:00:00.000Z');
    expect(serializeTimestamps({ expiryDate, manufacturingDate: null })).toEqual({
      expiryDate: '2027-01-31',
      manufacturingDate: null,
    });
  });

  it('mốc thời gian thường (confirmedAt) vẫn là ISO đầy đủ', () => {
    const confirmedAt = new Date('2026-10-14T03:04:05.000Z');
    const result = serializeTimestamps({ confirmedAt });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ confirmedAt: '2026-10-14T03:04:05.000Z' });
  });

  it('dateOfBirth của người dùng không đổi định dạng — giữ hợp đồng API cũ', () => {
    const dateOfBirth = new Date('2000-05-01T00:00:00.000Z');
    expect(JSON.parse(JSON.stringify(serializeTimestamps({ dateOfBirth })))).toEqual({
      dateOfBirth: '2000-05-01T00:00:00.000Z',
    });
  });
});
