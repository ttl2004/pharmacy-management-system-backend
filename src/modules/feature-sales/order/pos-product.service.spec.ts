import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { PosProductService } from './pos-product.service';
import { PosProductRepository, PosProductRow } from './repositories/pos-product.repository';

const actorOf = (role: AuthRole, branchId: string | null): RequestActor =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 }, ip: null }) as unknown as RequestActor;
const ss = actorOf(AuthRole.SALES_STAFF, 'b1');

const product: PosProductRow = {
  id: 'p1',
  code: 'PARA',
  name: 'Paracetamol',
  imageUrls: ['https://cdn/p1.jpg'],
  requiresPrescription: false,
  units: [
    { id: 'vien', conversionRate: 1, salePrice: 500, barcode: null, isBaseUnit: true, unit: { name: 'Viên' } },
    {
      id: 'vi',
      conversionRate: 10,
      salePrice: 4500,
      barcode: '8935000000022',
      isBaseUnit: false,
      unit: { name: 'Vỉ' },
    },
  ],
};

describe('PosProductService', () => {
  const products = {
    findPage: jest.fn(),
    findByBarcode: jest.fn(),
    sellableQuantities: jest.fn().mockResolvedValue(new Map([['p1', 25]])),
  };
  const service = new PosProductService(products as unknown as PosProductRepository);

  beforeEach(() => jest.clearAllMocks());

  it('quét mã vạch của vỉ → trả đúng đơn vị vỉ, lượng bán được quy theo từng đơn vị', async () => {
    products.findByBarcode.mockResolvedValue(product);
    const result = await service.search({ barcode: '8935000000022', page: 1, limit: 10 }, ss, '2026-10-17');
    expect(products.sellableQuantities).toHaveBeenCalledWith('b1', ['p1'], '2026-10-17');
    expect(result.hits[0]).toMatchObject({
      matchedUnitId: 'vi',
      sellableBaseQuantity: 25,
      imageUrl: 'https://cdn/p1.jpg',
      units: [
        { id: 'vien', sellableQuantity: 25 },
        { id: 'vi', sellableQuantity: 2 },
      ],
    });
  });

  it('mã vạch không khớp → danh sách rỗng, không lỗi', async () => {
    products.findByBarcode.mockResolvedValue(null);
    const result = await service.search({ barcode: 'khong-co', page: 1, limit: 10 }, ss);
    expect(result).toMatchObject({ hits: [], total: 0 });
  });

  it('ADMIN không chỉ định chi nhánh → 1002; SS xem chi nhánh khác → 1506', async () => {
    await expect(service.search({ page: 1, limit: 10 }, actorOf(AuthRole.ADMIN, null))).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    // Lỗi phạm vi là ForbiddenException của module quyền — mã nằm trong `response.code`.
    await expect(service.search({ branchId: 'b2', page: 1, limit: 10 }, ss)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });
});
