import { Prisma } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import {
  InteractionKnowledgeRepository,
  isUnavailableError,
  LOOKUP_TIMEOUT_MS,
} from './interaction-knowledge.repository';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

describe('InteractionKnowledgeRepository', () => {
  const prisma = { $queryRaw: jest.fn() };
  const repository = new InteractionKnowledgeRepository(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(repository['logger'], 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('mất kết nối / chờ pool quá lâu → 1611 (luồng bán lùi về kiểm tra thủ công)', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(known('P1001'));
    await expect(repository.loadForCheck(['p1'])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
    prisma.$queryRaw.mockRejectedValueOnce(known('P2024'));
    await expect(repository.loadForWarnings(['p1'])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
  });

  it('lỗi khác (vd SQL sai) ném nguyên để lộ ra 500, không đẩy mọi đơn sang duyệt thủ công', async () => {
    const sqlBug = known('P2010', { code: '42703', message: 'column does not exist' });
    prisma.$queryRaw.mockRejectedValueOnce(sqlBug);

    await expect(repository.loadForCheck(['p1'])).rejects.toBe(sqlBug);
  });

  it(`quá ${LOOKUP_TIMEOUT_MS}ms → 1611, không treo theo DB chậm`, async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValueOnce(new Promise(() => undefined));

    const pending = repository.loadForCheck(['p1']);
    jest.advanceTimersByTime(LOOKUP_TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({ errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE });
  });

  it('câu SQL xong trước hạn thì trả kết quả', async () => {
    const row = { products: [], mapping: [], interactions: [], dataLoaded: true };
    prisma.$queryRaw.mockResolvedValueOnce([row]);

    await expect(repository.loadForCheck(['p1'])).resolves.toBe(row);
  });

  it('isUnavailableError: phân loại lỗi', () => {
    expect(isUnavailableError(new Prisma.PrismaClientInitializationError('down', 'test'))).toBe(true);
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])
      expect(isUnavailableError(known(code))).toBe(true);
    for (const sqlState of ['08006', '53300', '57014', '57P01']) {
      expect(isUnavailableError(known('P2010', { code: sqlState }))).toBe(true);
    }
    expect(isUnavailableError(known('P2010', { code: '42601' }))).toBe(false);
    expect(isUnavailableError(known('P2002'))).toBe(false);
    expect(isUnavailableError(new Error('bug'))).toBe(false);
  });
});
