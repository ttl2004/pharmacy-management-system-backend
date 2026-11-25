import { PrismaClient, ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorCode } from 'src/common/types/error-code';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { InteractionKnowledgeRepository } from './interaction-knowledge.repository';
import { SafetyCheckService } from './safety-check.service';

/** Câu SQL một vòng (giỏ hàng → số đăng ký → dữ liệu tương tác) trên PostgreSQL thật, schema test riêng. */
describe('InteractionKnowledgeRepository (db)', () => {
  let prisma: PrismaClient;
  let repository: InteractionKnowledgeRepository;
  let service: SafetyCheckService;
  let categoryId: string;
  let unitId: string;
  /** Mã hàng → id hàng hoá. */
  const ids: Record<string, string> = {};

  const mapping = (
    registrationNumber: string,
    drugName: string,
    ingredientOrder: number,
    ddinterId: string | null,
    ddinterDrug: string | null,
  ) => ({
    registrationNumber,
    drugName,
    drugGroup: 'tan_duoc',
    ingredientOrder,
    matchMethod: ddinterId ? 'exact' : 'no_match',
    ddinterId,
    ddinterDrug,
    needsReview: false,
  });

  const product = async (
    code: string,
    registrationNumber: string | null,
    extra: { type?: ProductType; isDeleted?: boolean } = {},
  ) => {
    const type = extra.type ?? ProductType.DRUG;
    const drugId =
      type === ProductType.DRUG
        ? (
            await prisma.drug.create({
              data: { code: `D-${code}`, name: code, syncedAt: new Date(), registrationNumber },
            })
          ).id
        : null;
    const created = await prisma.product.create({
      data: { code, name: `Hàng ${code}`, categoryId, baseUnitId: unitId, type, drugId, isDeleted: extra.isDeleted },
    });
    ids[code] = created.id;
  };

  const seedInteractionData = async () => {
    await prisma.nationalDrugDdinterMapping.createMany({
      data: [
        // Thứ tự chèn đảo lộn để kiểm tra ORDER BY trong SQL
        mapping('REG-COMBO', 'Panadol Extra', 2, 'DD4', 'Caffeine'),
        mapping('REG-COMBO', 'Panadol Extra', 1, 'DD3', 'Acetaminophen'),
        mapping('REG-WARFARIN', 'Warfarin 5mg', 1, 'DD1', 'Warfarin'),
        mapping('REG-ASPIRIN', 'Aspirin 81mg', 1, 'DD2', 'Aspirin'),
        mapping('REG-PARTIAL', 'Thuốc nửa map', 1, 'DD2', 'Aspirin'),
        mapping('REG-PARTIAL', 'Thuốc nửa map', 2, null, null),
        mapping('REG-EMPTY', 'Không ghi thành phần', 0, null, null),
        mapping('REG-OTHER', 'Không có trong giỏ', 1, 'DD9', 'Other'),
      ],
    });
    await prisma.ddinterInteraction.createMany({
      data: [
        {
          id: 1,
          ddinterIdA: 'DD1',
          drugA: 'W',
          ddinterIdB: 'DD2',
          drugB: 'A',
          level: 'Major',
          interaction: 'Bleeding.',
          management: 'Avoid.',
        },
        // Lưu ngược chiều
        {
          id: 2,
          ddinterIdA: 'DD3',
          drugA: 'P',
          ddinterIdB: 'DD1',
          drugB: 'W',
          level: 'Moderate',
          interaction: 'INR.',
          management: null,
        },
        // Hai hoạt chất của CÙNG một thuốc phối hợp → SQL bỏ (chỉ so giữa hai thuốc khác nhau)
        {
          id: 3,
          ddinterIdA: 'DD3',
          drugA: 'P',
          ddinterIdB: 'DD4',
          drugB: 'C',
          level: 'Minor',
          interaction: null,
          management: null,
        },
        // Một đầu không thuộc giỏ → SQL không trả
        {
          id: 4,
          ddinterIdA: 'DD1',
          drugA: 'W',
          ddinterIdB: 'DD9',
          drugB: 'O',
          level: 'Major',
          interaction: null,
          management: null,
        },
      ],
    });
    await prisma.drugDiseaseInteraction.createMany({
      data: [
        {
          id: 2,
          drugId: 'DD2',
          drugName: 'A',
          level: 2,
          severity: 'Moderate',
          diseaseName: 'Asthma',
          description: 'b',
        },
        {
          id: 1,
          drugId: 'DD2',
          drugName: 'A',
          level: 3,
          severity: 'Major',
          diseaseName: 'Peptic Ulcer',
          description: 'a',
        },
        { id: 3, drugId: 'DD2', drugName: 'A', level: 2, severity: 'Moderate', diseaseName: 'Gout', description: null },
        { id: 4, drugId: 'DD9', drugName: 'O', level: 3, severity: 'Major', diseaseName: 'X', description: null },
      ],
    });
    await prisma.drugFoodInteraction.createMany({
      data: [
        {
          id: 1,
          drugId: 'DD1',
          drugName: 'W',
          level: 2,
          severity: 'Moderate',
          foodName: 'spinach',
          description: 'K',
          management: 's',
        },
      ],
    });
  };

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repository = new InteractionKnowledgeRepository(prisma as unknown as PrismaService);
    service = new SafetyCheckService(repository);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    categoryId = (await prisma.category.create({ data: { name: 'Thuốc' } })).id;
    unitId = (await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } })).id;
    await product('WARFARIN', 'REG-WARFARIN');
    await product('COMBO', ' REG-COMBO\t'); // số đăng ký trong danh mục có khoảng trắng
    await product('ASPIRIN', 'REG-ASPIRIN');
    await product('PARTIAL', 'REG-PARTIAL');
    await product('EMPTY', 'REG-EMPTY');
    await product('NOPE', 'REG-NOPE');
    await product('NONUM', null);
    await product('MASK', null, { type: ProductType.GOODS });
    await product('GONE', 'REG-ASPIRIN', { isDeleted: true });
  });

  it('loadForCheck: giỏ theo thứ tự gửi lên, dòng map theo (số, thứ tự), chỉ cặp giữa hai thuốc KHÁC nhau', async () => {
    await seedInteractionData();

    const rows = await repository.loadForCheck([ids.MASK, ids.WARFARIN, ids.COMBO, ids.ASPIRIN, ids.EMPTY]);

    expect(rows.products).toEqual([
      { id: ids.MASK, name: 'Hàng MASK', type: 'GOODS', registrationNumber: null },
      { id: ids.WARFARIN, name: 'Hàng WARFARIN', type: 'DRUG', registrationNumber: 'REG-WARFARIN' },
      { id: ids.COMBO, name: 'Hàng COMBO', type: 'DRUG', registrationNumber: ' REG-COMBO\t' },
      { id: ids.ASPIRIN, name: 'Hàng ASPIRIN', type: 'DRUG', registrationNumber: 'REG-ASPIRIN' },
      { id: ids.EMPTY, name: 'Hàng EMPTY', type: 'DRUG', registrationNumber: 'REG-EMPTY' },
    ]);
    expect(rows.mapping.map((r) => [r.registrationNumber, r.ingredientOrder, r.ddinterId])).toEqual([
      ['REG-ASPIRIN', 1, 'DD2'],
      ['REG-COMBO', 1, 'DD3'],
      ['REG-COMBO', 2, 'DD4'],
      ['REG-EMPTY', 0, null],
      ['REG-WARFARIN', 1, 'DD1'],
    ]);
    expect(rows.interactions.map((r) => `${r.ddinterIdA}-${r.ddinterIdB}`).sort()).toEqual(['DD1-DD2', 'DD3-DD1']);
    expect(rows.interactions.find((r) => r.ddinterIdA === 'DD1')).toEqual({
      ddinterIdA: 'DD1',
      ddinterIdB: 'DD2',
      level: 'Major',
      interaction: 'Bleeding.',
      management: 'Avoid.',
    });
    expect(rows.dataLoaded).toBe(true);
  });

  it('hàng đã xoá / không tồn tại không có trong products (để SafetyCheckService báo 1602)', async () => {
    await seedInteractionData();

    const rows = await repository.loadForCheck([ids.WARFARIN, ids.GONE, '00000000-0000-4000-8000-000000000000']);
    expect(rows.products.map((p) => p.id)).toEqual([ids.WARFARIN]);
    await expect(service.check([ids.WARFARIN, ids.GONE])).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('check đầu-cuối qua DB: cảnh báo theo hàng hoá, hàng chưa kiểm tra được', async () => {
    await seedInteractionData();

    const result = await service.check([
      ids.COMBO,
      ids.WARFARIN,
      ids.PARTIAL,
      ids.EMPTY,
      ids.NOPE,
      ids.NONUM,
      ids.MASK,
    ]);

    expect(result.warnings.map((w) => [w.id, w.severity, w.products.map((p) => p.name)])).toEqual([
      ['ddi:DD1:DD2', 'major', ['Hàng WARFARIN', 'Hàng PARTIAL']],
      ['ddi:DD1:DD3', 'moderate', ['Hàng COMBO', 'Hàng WARFARIN']],
    ]);
    expect(result.majorWarningIds).toEqual(['ddi:DD1:DD2']);
    expect(result.unchecked).toEqual([
      { productId: ids.NONUM, name: 'Hàng NONUM', reason: 'NO_REGISTRATION_NUMBER' },
      { productId: ids.NOPE, name: 'Hàng NOPE', reason: 'NOT_IN_INTERACTION_DATA' },
      { productId: ids.PARTIAL, name: 'Hàng PARTIAL', reason: 'INCOMPLETE_DATA' },
      { productId: ids.EMPTY, name: 'Hàng EMPTY', reason: 'INCOMPLETE_DATA' },
    ]);
  });

  it('bảng dữ liệu tương tác rỗng → dataLoaded=false → 1611 (không phải "không có cảnh báo"); 1 thuốc vẫn bán được', async () => {
    const rows = await repository.loadForCheck([ids.WARFARIN, ids.ASPIRIN]);
    expect(rows).toMatchObject({ mapping: [], interactions: [], dataLoaded: false });

    await expect(service.check([ids.WARFARIN, ids.ASPIRIN])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
    await expect(service.drugWarnings([ids.WARFARIN])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
    await expect(service.check([ids.WARFARIN, ids.MASK])).resolves.toMatchObject({ hasMajor: false, warnings: [] });
  });

  it('chỉ thiếu bảng cặp tương tác (bảng map có dữ liệu) cũng là chưa nạp xong', async () => {
    await seedInteractionData();
    await prisma.ddinterInteraction.deleteMany();

    await expect(repository.loadForCheck([ids.WARFARIN])).resolves.toMatchObject({ dataLoaded: false });
    await expect(repository.loadForWarnings([ids.WARFARIN])).resolves.toMatchObject({ dataLoaded: true });
    await prisma.drugFoodInteraction.deleteMany();
    await expect(repository.loadForWarnings([ids.WARFARIN])).resolves.toMatchObject({ dataLoaded: false });
  });

  it('loadForWarnings + drugWarnings: lưu ý theo id, chỉ của hoạt chất đã map, nặng trước', async () => {
    await seedInteractionData();

    const rows = await repository.loadForWarnings([ids.ASPIRIN, ids.WARFARIN]);
    expect(rows.diseases.map((d) => d.diseaseName)).toEqual(['Peptic Ulcer', 'Asthma', 'Gout']);
    expect(rows.foods.map((f) => f.foodName)).toEqual(['spinach']);

    const result = await service.drugWarnings([ids.ASPIRIN, ids.MASK, ids.WARFARIN]);
    expect(result.map((d) => [d.name, d.hasData, d.diseases.map((x) => x.diseaseName), d.foods.length])).toEqual([
      ['Hàng ASPIRIN', true, ['Peptic Ulcer', 'Asthma', 'Gout'], 0],
      ['Hàng WARFARIN', true, [], 1],
    ]);
    expect(result[0].diseases[2]).toEqual({
      ingredient: 'Aspirin',
      severity: 'moderate',
      diseaseName: 'Gout',
      description: '',
    });
  });
});
