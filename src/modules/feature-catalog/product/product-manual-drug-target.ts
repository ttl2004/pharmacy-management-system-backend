import { DrugSource, Prisma } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { DuplicateResolutionRequest, ManualDrugInput } from '../drug-leaflet/dtos/manual-drug.request';
import {
  type DuplicateDecision,
  normalizeRegistration,
  RegistrationDuplicateChecker,
} from '../drug-leaflet/registration-duplicate.checker';

/**
 * Thuốc mà khối `drug` của `PATCH /product/:id` sẽ ghi vào (design §5.7):
 * - `KEEP`: ghi vào chính thuốc MANUAL đang gắn, sản phẩm không đổi thuốc;
 * - `LINK_DQG`: chuyển sản phẩm sang thuốc DQG trùng số đăng ký, không ghi khối `drug`;
 * - `OVERWRITE_MANUAL`: chuyển sang thuốc MANUAL trùng số đăng ký và ghi đè nó bằng khối `drug`.
 */
export type ManualDrugTarget = { type: 'KEEP'; drugId: string } | Exclude<DuplicateDecision, { type: 'NEW' }>;

type CurrentDrug = { id: string; source: DrugSource; registrationNumber: string | null };

/**
 * Chỉ đọc và khoá, không ghi. Thuốc đang gắn phải là MANUAL. Chỉ kiểm trùng khi số đăng ký (đã chuẩn hoá) thực sự đổi;
 * khi đó giữ khoá `drug-registration:<số mới>` - lấy SAU khoá sản phẩm/mã vạch đầu transaction và TRƯỚC mọi khoá
 * `drug:<id>`, cùng thứ tự với lưu bản nháp, nên không tạo vòng chờ.
 */
export async function resolveManualDrugTarget(
  tx: Prisma.TransactionClient,
  checker: RegistrationDuplicateChecker,
  current: CurrentDrug | null,
  input: ManualDrugInput,
  resolution?: DuplicateResolutionRequest,
): Promise<ManualDrugTarget> {
  if (!current) {
    throw new ErrorException({
      code: ErrorCode.DRUG_NOT_MANUAL,
      message: 'Sản phẩm chưa gắn thuốc nhập tay, không sửa được thông tin thuốc',
    });
  }
  if (current.source !== DrugSource.MANUAL) {
    throw new ErrorException({
      code: ErrorCode.DRUG_NOT_MANUAL,
      message: 'Thuốc thuộc danh mục CSDL Dược, chỉ cập nhật bằng đồng bộ',
    });
  }

  const changed =
    normalizeRegistration(input.registrationNumber) !== normalizeRegistration(current.registrationNumber ?? '');
  if (!changed) return { type: 'KEEP', drugId: current.id };

  await checker.lock(tx, input.registrationNumber);
  const found = await checker.find(tx, input.registrationNumber, current.id);
  const decision = checker.decide(found, resolution);
  return decision.type === 'NEW' ? { type: 'KEEP', drugId: current.id } : decision;
}
