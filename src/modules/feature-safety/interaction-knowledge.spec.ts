import { buildDrugWarnings, buildInteractionCheck, pairKey, parseSeverity } from './interaction-knowledge';
import type { DiseaseRow, FoodRow, InteractionRow, MappingRow } from './interaction-knowledge.repository';

/*
 * Bản chuyển các test của TTT-BE (tests/conftest.py, test_interaction_service.py, test_api.py) — cùng bộ dữ liệu
 * dựng tay, nhưng ở dạng dòng DB mà repository trả về.
 */

const map = (
  registrationNumber: string,
  drugName: string,
  ingredientOrder: number,
  ddinterId: string | null = null,
  ddinterDrug: string | null = null,
): MappingRow => ({ registrationNumber, drugName, ingredientOrder, ddinterId, ddinterDrug });

const MAPPING: MappingRow[] = [
  map('REG-WARFARIN', 'Warfarin 5mg', 1, 'DD1', 'Warfarin'),
  map('REG-ASPIRIN', 'Aspirin 81mg', 1, 'DD2', 'Aspirin'),
  map('REG-PARA', 'Panadol', 1, 'DD3', 'Acetaminophen'),
  // Thuốc phối hợp: Paracetamol + Cafein — trùng hoạt chất với Panadol
  map('REG-PARA-CAF', 'Panadol Extra', 1, 'DD3', 'Acetaminophen'),
  map('REG-PARA-CAF', 'Panadol Extra', 2, 'DD4', 'Caffeine'),
  // Còn một hoạt chất chưa map
  map('REG-PARTIAL', 'Thuốc nửa map', 1, 'DD2', 'Aspirin'),
  map('REG-PARTIAL', 'Thuốc nửa map', 2, null, null),
  // Dòng đánh dấu "không ghi thành phần"
  map('REG-EMPTY', 'Thuốc không ghi thành phần', 0),
];

const INTERACTIONS: InteractionRow[] = [
  {
    ddinterIdA: 'DD1',
    ddinterIdB: 'DD2',
    level: 'Major',
    interaction: 'Increased bleeding risk.',
    management: 'Avoid combination.',
  },
  // Lưu theo chiều ngược (B < A) — vẫn phải tìm thấy
  {
    ddinterIdA: 'DD3',
    ddinterIdB: 'DD1',
    level: 'Moderate',
    interaction: 'May increase INR.',
    management: 'Monitor INR.',
  },
  { ddinterIdA: 'DD4', ddinterIdB: 'DD2', level: 'Unknown', interaction: null, management: 'None' },
];

const DISEASES: DiseaseRow[] = [
  { drugId: 'DD2', severity: 'Major', diseaseName: 'Peptic Ulcer', description: 'GI bleeding.' },
];
const FOODS: FoodRow[] = [
  {
    drugId: 'DD1',
    severity: 'Moderate',
    foodName: 'spinach',
    description: 'Vitamin K.',
    management: 'Keep intake steady.',
  },
];

/** Mô phỏng câu SQL: chỉ trả dòng của các số đăng ký (đã cắt khoảng trắng) gửi lên, rồi gọi hàm thuần. */
function pick(numbers: string[], mapping = MAPPING) {
  const wanted = new Set(numbers.map((n) => n.trim()));
  const rows = mapping.filter((row) => wanted.has(row.registrationNumber));
  const ids = new Set(rows.filter((r) => r.ingredientOrder !== 0 && r.ddinterId).map((r) => r.ddinterId!));
  return { rows, ids };
}

const service = {
  checkInteractions: (numbers: string[], mapping = MAPPING, interactions = INTERACTIONS) => {
    const { rows, ids } = pick(numbers, mapping);
    const pairs = interactions.filter((row) => ids.has(row.ddinterIdA) && ids.has(row.ddinterIdB));
    return Promise.resolve(buildInteractionCheck(numbers, rows, pairs));
  },
  getDrugWarnings: (numbers: string[], mapping = MAPPING, diseases = DISEASES, foods = FOODS) => {
    const { rows, ids } = pick(numbers, mapping);
    return Promise.resolve(
      buildDrugWarnings(
        numbers,
        rows,
        diseases.filter((row) => ids.has(row.drugId)),
        foods.filter((row) => ids.has(row.drugId)),
      ),
    );
  },
};

describe('interaction-knowledge (bản chuyển từ TTT-BE)', () => {
  describe('checkInteractions', () => {
    it('cặp nghiêm trọng tìm thấy theo cả hai chiều; drug1 là thuốc gửi lên trước', async () => {
      const result = await service.checkInteractions(['REG-ASPIRIN', 'REG-WARFARIN']);

      expect(result.hasMajor).toBe(true);
      expect(result.interactions).toEqual([
        {
          id: 'ddi:DD1:DD2',
          severity: 'major',
          drug1: { registrationNumber: 'REG-ASPIRIN', name: 'Aspirin 81mg' },
          drug2: { registrationNumber: 'REG-WARFARIN', name: 'Warfarin 5mg' },
          ingredient1: 'Aspirin',
          ingredient2: 'Warfarin',
          description: 'Increased bleeding risk.',
          management: 'Avoid combination.',
        },
      ]);
    });

    it('cặp lưu ngược chiều trong bảng vẫn tìm thấy, id luôn là mã nhỏ:mã lớn', async () => {
      const result = await service.checkInteractions(['REG-WARFARIN', 'REG-PARA']);

      expect(result.interactions.map((pair) => [pair.id, pair.ingredient1, pair.ingredient2])).toEqual([
        ['ddi:DD1:DD3', 'Warfarin', 'Acetaminophen'],
      ]);
    });

    it('sắp nặng trước', async () => {
      const result = await service.checkInteractions(['REG-PARA', 'REG-WARFARIN', 'REG-ASPIRIN']);

      expect(result.interactions.map((pair) => pair.severity)).toEqual(['major', 'moderate']);
    });

    it('cùng mức thì giữ thứ tự thuốc gửi lên (sắp xếp ổn định)', async () => {
      // Hai cặp moderate: (PARA, WARFARIN) rồi (WARFARIN, PARA-CAF) theo thứ tự giỏ
      const result = await service.checkInteractions(['REG-PARA', 'REG-WARFARIN', 'REG-PARA-CAF']);

      expect(result.interactions.map((pair) => [pair.drug1.registrationNumber, pair.drug2.registrationNumber])).toEqual(
        [
          ['REG-PARA', 'REG-WARFARIN'],
          ['REG-WARFARIN', 'REG-PARA-CAF'],
        ],
      );
    });

    it('không có cặp tương tác → hasMajor = false', async () => {
      const result = await service.checkInteractions(['REG-PARA', 'REG-ASPIRIN']);

      expect(result.interactions).toEqual([]);
      expect(result.hasMajor).toBe(false);
    });

    it('mức Unknown vẫn trả về nhưng không tính là nghiêm trọng; "None"/null → chuỗi rỗng', async () => {
      const result = await service.checkInteractions(['REG-PARA-CAF', 'REG-ASPIRIN']);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0]).toMatchObject({ severity: 'unknown', description: '', management: '' });
      expect(result.hasMajor).toBe(false);
    });

    it('trùng hoạt chất: báo dup, không báo thành cặp tương tác', async () => {
      const result = await service.checkInteractions(['REG-PARA', 'REG-PARA-CAF']);

      expect(result.duplicates).toEqual([
        {
          id: 'dup:DD3',
          ingredient: 'Acetaminophen',
          drugs: [
            { registrationNumber: 'REG-PARA', name: 'Panadol' },
            { registrationNumber: 'REG-PARA-CAF', name: 'Panadol Extra' },
          ],
        },
      ]);
      expect(result.interactions).toEqual([]);
    });

    it('gửi cùng một thuốc 2 lần thì bỏ qua', async () => {
      const result = await service.checkInteractions(['REG-PARA', 'REG-PARA']);

      expect(result.duplicates).toEqual([]);
      expect(result.interactions).toEqual([]);
    });

    it('báo notFound và incomplete (thiếu map hoặc không ghi thành phần); phần đã map vẫn được kiểm', async () => {
      const result = await service.checkInteractions(['REG-WARFARIN', 'NOPE', 'REG-PARTIAL', 'REG-EMPTY']);

      expect(result.notFound).toEqual(['NOPE']);
      expect(result.incomplete).toEqual(['REG-PARTIAL', 'REG-EMPTY']);
      expect(result.hasMajor).toBe(true);
    });

    it('tra theo số đăng ký đã cắt khoảng trắng; notFound trả nguyên văn', async () => {
      const result = await service.checkInteractions(['  REG-ASPIRIN ', 'REG-WARFARIN', ' NOPE ']);

      expect(result.interactions.map((pair) => pair.id)).toEqual(['ddi:DD1:DD2']);
      expect(result.notFound).toEqual([' NOPE ']);
    });

    it('danh sách rỗng → kết quả rỗng', async () => {
      await expect(service.checkInteractions([])).resolves.toEqual({
        interactions: [],
        duplicates: [],
        hasMajor: false,
        notFound: [],
        incomplete: [],
      });
    });

    it('một thuốc map CÙNG một mã DDInter hai lần (có 29 thuốc như vậy trong dữ liệu thật): giữ đúng như TTT-BE', async () => {
      const mapping = [
        ...MAPPING,
        map('REG-DOUBLE', 'Thuốc map đôi', 1, 'DD2', 'Aspirin'),
        map('REG-DOUBLE', 'Thuốc map đôi', 2, 'DD2', 'Aspirin'),
      ];

      const result = await service.checkInteractions(['REG-WARFARIN', 'REG-DOUBLE', 'REG-ASPIRIN'], mapping);

      // TTT-BE lặp theo từng hoạt chất nên cặp (Warfarin, Aspirin) của REG-DOUBLE ra 2 lần (SafetyCheckService gộp theo id)
      expect(result.interactions.map((p) => [p.id, p.drug2.registrationNumber])).toEqual([
        ['ddi:DD1:DD2', 'REG-DOUBLE'],
        ['ddi:DD1:DD2', 'REG-DOUBLE'],
        ['ddi:DD1:DD2', 'REG-ASPIRIN'],
      ]);
      // Trùng hoạt chất: mỗi thuốc chỉ đếm một lần
      expect(result.duplicates).toEqual([
        {
          id: 'dup:DD2',
          ingredient: 'Aspirin',
          drugs: [
            { registrationNumber: 'REG-DOUBLE', name: 'Thuốc map đôi' },
            { registrationNumber: 'REG-ASPIRIN', name: 'Aspirin 81mg' },
          ],
        },
      ]);
      expect(result.incomplete).toEqual([]);
      // Lưu ý cũng lặp theo hoạt chất
      const warnings = await service.getDrugWarnings(['REG-DOUBLE'], mapping);
      expect(warnings.drugs[0].diseases.map((d) => d.diseaseName)).toEqual(['Peptic Ulcer', 'Peptic Ulcer']);
    });
  });

  describe('getDrugWarnings', () => {
    it('lưu ý theo từng thuốc; số đăng ký lạ vào notFound', async () => {
      const result = await service.getDrugWarnings(['REG-WARFARIN', 'NOPE']);

      expect(result).toEqual({
        drugs: [
          {
            registrationNumber: 'REG-WARFARIN',
            isFullyMapped: true,
            diseases: [],
            foods: [
              {
                ingredient: 'Warfarin',
                severity: 'moderate',
                foodName: 'spinach',
                description: 'Vitamin K.',
                management: 'Keep intake steady.',
              },
            ],
          },
        ],
        notFound: ['NOPE'],
      });
    });

    it('thuốc nửa map vẫn có lưu ý của hoạt chất đã map, isFullyMapped = false', async () => {
      const result = await service.getDrugWarnings(['REG-PARTIAL', 'REG-EMPTY']);

      expect(result.drugs).toEqual([
        {
          registrationNumber: 'REG-PARTIAL',
          isFullyMapped: false,
          diseases: [
            { ingredient: 'Aspirin', severity: 'major', diseaseName: 'Peptic Ulcer', description: 'GI bleeding.' },
          ],
          foods: [],
        },
        { registrationNumber: 'REG-EMPTY', isFullyMapped: false, diseases: [], foods: [] },
      ]);
    });

    it('lưu ý sắp nặng trước, cùng mức giữ thứ tự hoạt chất rồi thứ tự dòng', async () => {
      const [drug] = (
        await service.getDrugWarnings(
          ['R'],
          [map('R', 'Thuốc', 1, 'X1', 'Một'), map('R', 'Thuốc', 2, 'X2', 'Hai')],
          [
            { drugId: 'X1', severity: 'Minor', diseaseName: 'a', description: null },
            { drugId: 'X1', severity: 'Moderate', diseaseName: 'b', description: '-' },
            { drugId: 'X2', severity: 'Moderate', diseaseName: 'c', description: ' x ' },
            { drugId: 'X2', severity: 'Major', diseaseName: 'd', description: null },
          ],
          [],
        )
      ).drugs;

      expect(drug.diseases.map((d) => [d.diseaseName, d.severity, d.description])).toEqual([
        ['d', 'major', ''],
        ['b', 'moderate', ''],
        ['c', 'moderate', 'x'],
        ['a', 'minor', ''],
      ]);
    });
  });

  it('parseSeverity: không phân biệt hoa thường, giá trị lạ → unknown', () => {
    expect(['Major', ' moderate ', 'MINOR', 'Unknown', 'Severe', '', null].map(parseSeverity)).toEqual([
      'major',
      'moderate',
      'minor',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('pairKey: không phụ thuộc thứ tự, so sánh chuỗi (DDInter10 < DDInter9)', () => {
    expect(pairKey('DDInter9', 'DDInter10')).toEqual(['DDInter10', 'DDInter9']);
    expect(pairKey('DDInter10', 'DDInter9')).toEqual(['DDInter10', 'DDInter9']);
  });
});
