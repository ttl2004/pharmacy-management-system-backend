import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { AdjustmentType, PaymentMethod, ReceiptStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  Matches,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';
import { MAX_BASE_QUANTITY } from '../../core/inventory.constants';

/** Trần một khoản tiền (VND) gửi lên — trong `int` để class-validator kiểm được, tổng tính bằng bigint. */
const MAX_MONEY = 2_000_000_000;

/**
 * Dòng phiếu điều chỉnh, số lượng theo đơn vị cơ bản. Trường cần gửi tuỳ loại phiếu (kiểm ở service):
 * - STOCK_TAKE: `actualQuantity` — số đếm thực tế (>= 0). Chênh lệch chốt lúc lập phiếu.
 * - DISPOSE / RETURN_TO_SUPPLIER: `quantity` — số đưa RA khỏi kho (> 0).
 * - OTHER: `quantity` — delta có dấu, khác 0.
 */
export class AdjustmentItemRequest {
  @IsUUID()
  @ApiProperty()
  batchId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BASE_QUANTITY)
  @ApiPropertyOptional({ description: 'STOCK_TAKE: số đếm thực tế' })
  actualQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(-MAX_BASE_QUANTITY)
  @Max(MAX_BASE_QUANTITY)
  @ApiPropertyOptional({ description: 'DISPOSE/RETURN_TO_SUPPLIER: số đưa ra (> 0); OTHER: delta có dấu' })
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  reason?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  @ApiPropertyOptional({ description: 'RETURN_TO_SUPPLIER: giá trả lại / đơn vị cơ bản (bỏ trống = giá vốn lô)' })
  returnPrice?: number;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'RETURN_TO_SUPPLIER theo phiếu nhập: dòng phiếu nhập gốc của lô' })
  goodsReceiptItemId?: string;
}

/** Chi phí nhập hoàn lại trên phiếu trả: theo `code` của bản chụp chi phí phiếu nhập gốc. */
export class RefundExpenseRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty()
  code: string;

  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  @ApiProperty({ description: 'VND chi trên phiếu trả (≤ phần còn hoàn được)' })
  amount: number;
}

export class CreateAdjustmentRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM bỏ trống = chi nhánh mình; ADMIN bắt buộc' })
  branchId?: string;

  @IsEnum(AdjustmentType)
  @ApiProperty({ enum: AdjustmentType })
  type: AdjustmentType;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bắt buộc khi type = RETURN_TO_SUPPLIER' })
  supplierId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @ApiProperty({ example: 'Biên bản huỷ thuốc hết hạn số 12/2026' })
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ApiPropertyOptional()
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9_.\-/]+$/, { message: 'Mã phiếu chỉ gồm chữ không dấu, số và - _ . /' })
  @ApiPropertyOptional({ description: 'Bỏ trống = tự sinh. Trùng mã (kể cả phiếu đã huỷ) → 1601' })
  code?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'Ngày chứng từ (ISO); mặc định lúc lập' })
  documentDate?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Người xuất huỷ / người trả / người xuất dùng — nhân sự của chi nhánh phiếu' })
  handlerId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Người nhận (chỉ OTHER — xuất dùng nội bộ)' })
  receiverId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Loại xuất nội bộ (chỉ OTHER)' })
  internalUseTypeId?: string;

  // --- Tiền phiếu trả NCC (chỉ RETURN_TO_SUPPLIER) ---
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Trả theo phiếu nhập gốc (cùng chi nhánh, NCC; đã xác nhận)' })
  goodsReceiptId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  @ApiPropertyOptional({ description: 'Giảm giá VND (≤ tiền hàng). Không gửi cùng discountPercent' })
  discountAmount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @ApiPropertyOptional({ description: 'Giảm giá % trên tiền hàng' })
  discountPercent?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RefundExpenseRequest)
  @ApiPropertyOptional({ type: [RefundExpenseRequest] })
  refundExpenses?: RefundExpenseRequest[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  @ApiPropertyOptional({ description: 'Tiền NCC hoàn ngay (≤ cần trả); phần còn lại trừ công nợ' })
  supplierPaid?: number;

  @IsOptional()
  @IsIn([PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER])
  @ApiPropertyOptional({ enum: [PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER] })
  paymentMethod?: PaymentMethod;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemRequest)
  @ApiProperty({ type: [AdjustmentItemRequest] })
  items: AdjustmentItemRequest[];
}

/** Sửa phiếu NHÁP: thay toàn bộ (như tạo) — không đổi chi nhánh, loại phiếu. */
export class UpdateAdjustmentRequest extends OmitType(CreateAdjustmentRequest, ['branchId', 'type'] as const) {}

export class FavouriteAdjustmentRequest {
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Bỏ trống = đảo trạng thái hiện tại' })
  isFavourite?: boolean;
}

/** Danh sách id phân tách bằng dấu phẩy → mảng (quy ước FE `csv`). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;

export class CancelAdjustmentRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty()
  reason: string;
}

export class AdjustmentQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  branchId?: string;

  @IsOptional()
  @IsEnum(AdjustmentType)
  @ApiPropertyOptional({ enum: AdjustmentType })
  type?: AdjustmentType;

  @IsOptional()
  @IsEnum(ReceiptStatus)
  @ApiPropertyOptional({ enum: ReceiptStatus })
  status?: ReceiptStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  toDate?: string;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsEnum(ReceiptStatus, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Nhiều trạng thái, phân tách dấu phẩy (thay `status`)' })
  statuses?: ReceiptStatus[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Người tạo (csv)' })
  createdBy?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Người xuất/trả (csv)' })
  handlerIds?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Người nhận (csv)' })
  receiverIds?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Loại xuất nội bộ (csv)' })
  internalUseTypeIds?: string[];

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Mã/tên hàng có trong phiếu' })
  product?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Số lô có trong phiếu' })
  lot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Ghi chú / lý do chứa' })
  noteQ?: string;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Trả NCC: mã chi phí nhập hoàn lại (csv)' })
  refundCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Trả NCC: mã/tên nhà cung cấp chứa' })
  supplierQ?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Trả NCC: mã phiếu nhập gốc chứa' })
  receiptQ?: string;
}
