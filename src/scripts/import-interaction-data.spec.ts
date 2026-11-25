import {
  missingHeaders,
  parseCsv,
  rowToObject,
  describeTarget,
  parseArgs,
  toBool,
  toFloat,
  toInt,
  toKey,
  toText,
} from './import-interaction-data';

describe('import-interaction-data: phân tích CSV', () => {
  it('bỏ BOM, đọc ô có dấu phẩy, ngoặc kép thoát và xuống dòng', () => {
    const csv = '﻿a,b,c\r\n1,"x, y","dòng 1\nđòng ""2"""\r\n2,,z';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'dòng 1\nđòng "2"'],
      ['2', '', 'z'],
    ]);
  });

  it('bỏ dòng trống và chịu được file có xuống dòng cuối', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ô rỗng cuối dòng vẫn được giữ', () => {
    expect(parseCsv('a,b,c\n1,2,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('ném lỗi khi ô ngoặc kép không đóng', () => {
    expect(() => parseCsv('a\n"abc')).toThrow();
  });
});

describe('import-interaction-data: chuyển đổi giá trị', () => {
  it('toText: rỗng → null, None/- chỉ là rỗng khi được yêu cầu', () => {
    expect(toText('')).toBeNull();
    expect(toText('None')).toBe('None');
    expect(toText('None', true)).toBeNull();
    expect(toText('-', true)).toBeNull();
    expect(toText('nội dung', true)).toBe('nội dung');
  });

  it('toKey cắt khoảng trắng', () => {
    expect(toKey('  DDInter1 ')).toBe('DDInter1');
    expect(toKey('  ')).toBeNull();
  });

  it('toInt / toFloat', () => {
    expect(toInt('12')).toBe(12);
    expect(toInt('')).toBeNull();
    expect(() => toInt('1.5')).toThrow();
    expect(toFloat('95.5')).toBe(95.5);
    expect(toFloat('')).toBeNull();
    expect(() => toFloat('abc')).toThrow();
  });

  it('toBool', () => {
    expect(toBool('True')).toBe(true);
    expect(toBool('False')).toBe(false);
    expect(() => toBool('có')).toThrow();
    // needs_review trống là lỗi dữ liệu, không âm thầm coi là false
    expect(() => toBool('')).toThrow();
    expect(() => toBool(undefined)).toThrow();
  });

  it('missingHeaders và rowToObject', () => {
    expect(missingHeaders(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(rowToObject(['a', 'b'], ['1', '2'], 1)).toEqual({ a: '1', b: '2' });
    expect(() => rowToObject(['a', 'b'], ['1'], 7)).toThrow(/thứ 7/);
  });
});

describe('import-interaction-data: tham số và DB đích', () => {
  it('parseArgs: thư mục từ tham số hoặc INTERACTION_DATA_DIR; chỉ ghi khi có --yes', () => {
    expect(parseArgs(['/data', '--yes'], {})).toEqual({ dir: '/data', confirmed: true });
    expect(parseArgs([], { INTERACTION_DATA_DIR: '/env' })).toEqual({ dir: '/env', confirmed: false });
    expect(parseArgs(['/data'], { INTERACTION_DATA_DIR: '/env' }).dir).toBe('/data');
    expect(() => parseArgs(['--yes'], {})).toThrow(/Thiếu thư mục CSV/);
    expect(() => parseArgs(['/data', '--force'], {})).toThrow(/không hỗ trợ/);
    expect(() => parseArgs(['/a', '/b'], {})).toThrow(/một thư mục/);
  });

  it('describeTarget: host, cổng, tên DB — không lộ mật khẩu', () => {
    const target = describeTarget('postgresql://user:SECRET@db.example.com:6543/appdb?schema=public');
    expect(target).toBe('db.example.com:6543/appdb (schema public)');
    expect(target).not.toContain('SECRET');
    expect(() => describeTarget(undefined)).toThrow();
  });
});
