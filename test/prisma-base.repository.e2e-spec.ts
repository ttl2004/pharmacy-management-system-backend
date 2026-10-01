import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient, User } from '@prisma/client';
import { PrismaBaseRepository } from '../src/providers/abstract-base/repositories/prisma-base.repository';
import { AuthRole, RecordStatusEnum } from '../src/common/types/common.enum';

class UserTestRepository extends PrismaBaseRepository<User> {
  constructor(prisma: PrismaClient) {
    super(prisma, 'User');
  }
}

describe('PrismaBaseRepository', () => {
  let dir: string;
  let prisma: PrismaClient;
  let repo: UserTestRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pos-ndm-repo-'));
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: `file:${join(dir, 'test.sqlite')}` },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ datasourceUrl: `file:${join(dir, 'test.sqlite')}` });
    repo = new UserTestRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  let seq = 0;
  const makeUser = (over: Partial<User> = {}): Partial<User> => ({
    email: `user${++seq}@test.local`,
    fullName: 'Người dùng thử',
    role: AuthRole.MEMBER,
    status: RecordStatusEnum.ACTIVE,
    ...over,
  });

  it('create gán createdAt và isDeleted, để updatedAt null', async () => {
    const user = await repo.create(makeUser());
    expect(user.isDeleted).toBe(false);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeNull();
  });

  it('find bỏ qua bản ghi đã soft delete', async () => {
    const user = await repo.create(makeUser());
    await repo.softDelete({ id: user.id });

    expect(await repo.findOne({ id: user.id })).toBeNull();
    expect(await repo.findMany({})).toHaveLength(0);
  });

  it('softDelete trả false khi không có dòng nào bị sửa', async () => {
    expect(await repo.softDelete({ id: 'khong-ton-tai' })).toBe(false);
  });

  it('update gán updatedAt và trả bản ghi mới; trả null khi không khớp', async () => {
    const user = await repo.create(makeUser());
    const updated = await repo.update({ id: user.id }, { fullName: 'Tên mới' });

    expect(updated?.fullName).toBe('Tên mới');
    expect(updated?.updatedAt).toBeInstanceOf(Date);
    expect(await repo.update({ id: 'khong-ton-tai' }, { fullName: 'X' })).toBeNull();
  });

  it('tìm kiếm coi % và _ là văn bản thuần', async () => {
    await repo.create(makeUser({ fullName: 'Nguyễn Văn A' }));
    await repo.create(makeUser({ fullName: 'Nguyễn Văn B' }));
    await repo.create(makeUser({ fullName: 'Trần Thị C' }));

    const found = await repo.findMany({}, { search: 'Văn', searchFields: ['fullName'] });
    expect(found).toHaveLength(2);

    expect(await repo.findMany({}, { search: '%', searchFields: ['fullName'] })).toHaveLength(0);
    expect(await repo.findMany({}, { search: '_', searchFields: ['fullName'] })).toHaveLength(0);
  });

  it('sort mặc định createdAt DESC, bỏ qua field không tồn tại', async () => {
    const first = await repo.create(makeUser({ createdAt: new Date('2026-01-01T00:00:00Z') }));
    const second = await repo.create(makeUser({ createdAt: new Date('2026-02-01T00:00:00Z') }));

    expect((await repo.findMany({})).map((u) => u.id)).toEqual([second.id, first.id]);
    expect((await repo.findMany({}, { sort: 'khongCoField:asc' })).map((u) => u.id)).toEqual([second.id, first.id]);
    expect((await repo.findMany({}, { sort: 'email:asc' })).map((u) => u.email)).toEqual(
      [first.email, second.email].sort(),
    );
  });

  it('lọc theo null là IS NULL, không bị bỏ qua', async () => {
    await repo.create(makeUser({ createdBy: 'admin' }));
    const anonymous = await repo.create(makeUser());

    const result = await repo.findMany({ createdBy: null });
    expect(result.map((u) => u.id)).toEqual([anonymous.id]);
  });

  it('ranges lọc theo min/max', async () => {
    await repo.create(makeUser({ createdAt: new Date('2026-01-01T00:00:00Z') }));
    const mid = await repo.create(makeUser({ createdAt: new Date('2026-02-01T00:00:00Z') }));
    await repo.create(makeUser({ createdAt: new Date('2026-03-01T00:00:00Z') }));

    const result = await repo.findMany(
      {},
      { ranges: { createdAt: { min: new Date('2026-01-15T00:00:00Z'), max: new Date('2026-02-15T00:00:00Z') } } },
    );
    expect(result.map((u) => u.id)).toEqual([mid.id]);
  });

  it('phân trang trả hits, total, totalPages', async () => {
    for (let i = 0; i < 3; i++) await repo.create(makeUser());

    const page1 = await repo.findManyWithPagination({}, { limit: 2, page: 1 });
    expect(page1.hits).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);
  });
});
