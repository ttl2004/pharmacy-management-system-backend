import { ErrorCode } from 'src/common/types/error-code';
import { DrugSourceClient } from './drug-source.client';

const drug = (code: string) => ({
  code,
  name: `Thuốc ${code}`,
  drugGroup: null,
  controlType: null,
  isPrescription: false,
  registrationNumber: null,
  registeredAt: '2020-05-13',
  registrationExpiresAt: null,
  strength: null,
  ingredients: null,
  manufacturerName: null,
  countryOfOrigin: null,
  packagingSpec: null,
  route: null,
  // Cột tra cứu nguồn trả thêm — client bỏ qua.
  indications: 'Giảm đau',
});

const page = (items: unknown[], total: number) => ({ items, total });

function makeClient(...responses: unknown[]) {
  const fetchMock = jest.fn();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }
  global.fetch = fetchMock as never;
  const client = new DrugSourceClient({ getOrThrow: () => 'http://source.test' } as never);
  return { client, fetchMock };
}

const unavailable = { errorCode: ErrorCode.DRUG_SOURCE_UNAVAILABLE };

describe('DrugSourceClient', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('gộp đủ các trang tới khi bằng total, bỏ cột thừa', async () => {
    const first = Array.from({ length: 100 }, (_, i) => drug(`A${i}`));
    const { client, fetchMock } = makeClient(page(first, 101), page([drug('B')], 101));

    const drugs = await client.fetchAll();

    expect(drugs).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(drugs[0]).not.toHaveProperty('indications');
  });

  it('trang rỗng trước khi đủ total thì báo lỗi — không coi danh mục thiếu là trọn vẹn', async () => {
    const { client } = makeClient(page([drug('A')], 5), page([], 5));

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it('total đổi giữa các trang thì báo lỗi', async () => {
    const first = Array.from({ length: 100 }, (_, i) => drug(`A${i}`));
    const { client } = makeClient(page(first, 150), page([drug('B')], 120));

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it('trả nhiều hơn total thì báo lỗi', async () => {
    const { client } = makeClient(page([drug('A'), drug('B')], 1));

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it('mã thuốc trùng thì báo lỗi', async () => {
    const { client } = makeClient(page([drug('A'), drug('A')], 2));

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it.each([
    ['total không phải số nguyên', { items: [], total: '10' }],
    ['isPrescription không phải boolean', page([{ ...drug('A'), isPrescription: 'Có' }], 1)],
    ['ngày sai định dạng', page([{ ...drug('A'), registeredAt: '13/05/2020' }], 1)],
    ['mã dài quá cột', page([drug('X'.repeat(51))], 1)],
    ['thiếu tên', page([{ ...drug('A'), name: '  ' }], 1)],
  ])('dữ liệu sai định dạng (%s) thì báo DRUG_SOURCE_UNAVAILABLE', async (_case, body) => {
    const { client } = makeClient(body);

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it('JSON hỏng thì báo DRUG_SOURCE_UNAVAILABLE thay vì lỗi 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    }) as never;
    const client = new DrugSourceClient({ getOrThrow: () => 'http://source.test' } as never);

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
  });

  it('HTTP lỗi thì báo DRUG_SOURCE_UNAVAILABLE kèm mã HTTP', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as never;
    const client = new DrugSourceClient({ getOrThrow: () => 'http://source.test' } as never);

    await expect(client.fetchAll()).rejects.toMatchObject(unavailable);
    await expect(client.fetchAll()).rejects.toThrow('502');
  });
});
