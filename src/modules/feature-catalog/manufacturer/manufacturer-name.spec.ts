import { normalizeManufacturerName, simplifyText, stripAccents } from './manufacturer-name';

describe('stripAccents', () => {
  it('bỏ mọi dấu tiếng Việt, kể cả đ/Đ', () => {
    expect(stripAccents('Đà Nẵng đặc biệt ưu tiên Ỷ Ữ ộ')).toBe('Da Nang dac biet uu tien Y U o');
  });

  it('bỏ dấu Latin khác (é, ü, ñ)', () => {
    expect(stripAccents('Sanofi-Aventis Pasteur é ü ñ')).toBe('Sanofi-Aventis Pasteur e u n');
  });

  it('chịu được chuỗi dựng sẵn (NFC) lẫn tổ hợp (NFD)', () => {
    expect(stripAccents('Việt'.normalize('NFD'))).toBe('Viet');
    expect(stripAccents('Việt'.normalize('NFC'))).toBe('Viet');
  });
});

describe('simplifyText', () => {
  it('thường hoá, dấu câu thành khoảng trắng, gộp khoảng trắng, trim', () => {
    expect(simplifyText('  Co.,   Ltd. -- (ABC)/  ')).toBe('co ltd abc');
  });
});

describe('normalizeManufacturerName', () => {
  it.each([
    ['Công ty CP Dược phẩm Trung ương I', 'duoc pham trung uong 1'],
    ['CTCP DƯỢC PHẨM TRUNG ƯƠNG 1', 'duoc pham trung uong 1'],
    ['Công ty Cổ phần Dược phẩm Trung ương 1', 'duoc pham trung uong 1'],
    ['CÔNG TY CỔ PHẦN DƯỢC HẬU GIANG', 'duoc hau giang'],
    ['Dược Hậu Giang', 'duoc hau giang'],
    ['Cty TNHH MTV Dược phẩm ABC', 'duoc pham abc'],
    ['Công ty TNHH Một Thành Viên Dược phẩm ABC', 'duoc pham abc'],
    ['Công ty trách nhiệm hữu hạn Dược phẩm ABC', 'duoc pham abc'],
    ['Stada Việt Nam JSC', 'stada viet nam'],
    ['Sun Pharmaceutical Industries Ltd.', 'sun pharmaceutical industries'],
    ['Daewoong Pharmaceutical Co., Ltd', 'daewoong pharmaceutical'],
    ['DAEWOONG PHARMACEUTICAL CO.,LTD.', 'daewoong pharmaceutical'],
    ['Pfizer Inc.', 'pfizer'],
    ['Abbott Corp', 'abbott'],
    ['Abbott Corporation', 'abbott'],
    ['Glenmark Pharmaceuticals Limited', 'glenmark pharmaceuticals'],
    ['Cipla Pvt. Ltd', 'cipla'],
    ['Cipla Private Limited', 'cipla'],
    ['Boehringer Ingelheim Pharma GmbH & Co. KG', 'boehringer ingelheim pharma'],
    ['Laboratorios Normon, S.A.', 'laboratorios normon'],
    ['Menarini S.p.A.', 'menarini'],
    ['Bayer AG', 'bayer'],
    ['GlaxoSmithKline plc', 'glaxosmithkline'],
    ['Organon B.V.', 'organon'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeManufacturerName(input)).toBe(expected);
  });

  it('bỏ cụm pháp nhân ở giữa hoặc cuối tên, không chỉ ở đầu', () => {
    expect(normalizeManufacturerName('Dược phẩm ABC Công ty TNHH')).toBe('duoc pham abc');
    expect(normalizeManufacturerName('Imexpharm CTCP')).toBe('imexpharm');
  });

  it('chỉ bỏ khi là từ đứng riêng — không cắt giữa từ', () => {
    expect(normalizeManufacturerName('Corporate Pharma')).toBe('corporate pharma');
    expect(normalizeManufacturerName('Cophavina')).toBe('cophavina');
    expect(normalizeManufacturerName('Incepta')).toBe('incepta');
    expect(normalizeManufacturerName('Sagami')).toBe('sagami');
  });

  it('hậu tố quốc tế ngắn (co/sa/ag/bv…) chỉ bỏ ở cuối — đầu/giữa tên là một phần tên thật, không gộp nhầm', () => {
    expect(normalizeManufacturerName('BV Pharma')).toBe('bv pharma');
    expect(normalizeManufacturerName('Công ty CP BV Pharma')).toBe('bv pharma');
    expect(normalizeManufacturerName('AG Pharma')).not.toBe(normalizeManufacturerName('Pharma'));
    expect(normalizeManufacturerName('Dược phẩm Cổ truyền Việt')).toBe('duoc pham co truyen viet');
    expect(normalizeManufacturerName('Công ty Dược Sa Đéc')).toBe('duoc sa dec');
  });

  it('"CP" chỉ bỏ khi đi sau "công ty/cty" — "CP Pharma" khác "Pharma"', () => {
    expect(normalizeManufacturerName('CP Pharma')).toBe('cp pharma');
    expect(normalizeManufacturerName('Cty CP Dược ABC')).toBe('duoc abc');
  });

  it('cụm pháp nhân tiếng Việt bỏ cả khi đứng giữa tên', () => {
    expect(normalizeManufacturerName('Pharbaco - Công ty CP Dược phẩm TW I')).toBe('pharbaco duoc pham tw 1');
    expect(normalizeManufacturerName('Công ty TNHH MTV Dược Sài Gòn')).toBe('duoc sai gon');
  });

  it('đổi I/II/III đơn lẻ cuối tên thành 1/2/3', () => {
    expect(normalizeManufacturerName('Dược phẩm Trung ương II')).toBe('duoc pham trung uong 2');
    expect(normalizeManufacturerName('Dược phẩm Trung ương III')).toBe('duoc pham trung uong 3');
    expect(normalizeManufacturerName('Mekophar II Co., Ltd')).toBe('mekophar 2');
  });

  it('không đổi số La Mã ở giữa tên hoặc khi tên chỉ có một từ', () => {
    expect(normalizeManufacturerName('Pharma I Plus')).toBe('pharma i plus');
    expect(normalizeManufacturerName('I')).toBe('i');
    expect(normalizeManufacturerName('Pharma IV')).toBe('pharma iv');
  });

  it('không làm rỗng tên: bỏ hết thì rơi về bản chỉ bỏ dấu', () => {
    expect(normalizeManufacturerName('Công ty TNHH')).toBe('cong ty tnhh');
    expect(normalizeManufacturerName('Co., Ltd')).toBe('co ltd');
  });

  it('tên không có chữ/số thì trả chuỗi rỗng', () => {
    expect(normalizeManufacturerName('...')).toBe('');
    expect(normalizeManufacturerName('   ')).toBe('');
  });

  it('khác dấu/hoa thường/khoảng trắng vẫn ra cùng khoá', () => {
    const a = normalizeManufacturerName('  dược   hậu  giang ');
    expect(a).toBe(normalizeManufacturerName('DUOC HAU GIANG'));
    expect(a).toBe(normalizeManufacturerName('Dược-Hậu-Giang'));
  });

  it('tên khác nhau thật thì khoá khác nhau', () => {
    expect(normalizeManufacturerName('Dược phẩm Trung ương 1')).not.toBe(
      normalizeManufacturerName('Dược phẩm Trung ương 2'),
    );
  });
});
