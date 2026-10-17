import { containsPattern, escapeLike } from './like-pattern.util';

const BACKSLASH = '\\';

describe('escapeLike', () => {
  it('escape %, _ và chính dấu gạch chéo ngược', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    expect(escapeLike(BACKSLASH)).toHaveLength(2);
  });

  it('từ khoá thường giữ nguyên', () => {
    expect(escapeLike('Paracetamol 500')).toBe('Paracetamol 500');
  });

  it('containsPattern bọc % hai đầu sau khi escape', () => {
    expect(containsPattern('a%')).toBe('%a\\%%');
  });
});
