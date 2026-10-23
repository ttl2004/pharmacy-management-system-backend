import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { GoodsReceiptExpenseRequest } from './goods-receipt-expense.request';
import { GoodsReceiptItemRequest } from './goods-receipt-item.request';

/** Tiền cấp phiếu: dưới `Number.MAX_SAFE_INTEGER` rất xa, đủ cho mọi phiếu thật. */
const MAX_DOCUMENT_AMOUNT = 1_000_000_000_000;
const MAX_EXPENSES = 10;

/** Hình thức trả NCC của phiếu nhập — COD không áp dụng (CHECK trong DB cũng cấm). */
const RECEIPT_PAYMENT_METHODS = [PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER];

/** Phần thân dùng chung cho tạo phiếu nháp (POST) và thay phiếu nháp (PUT). */
export class GoodsReceiptDraftFields {
  @IsUUID()
  @ApiProperty()
  supplierId: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @ApiPropertyOptional({ description: 'Thời điểm nhận hàng thực tế (ISO 8601). Bỏ trống = lúc xác nhận.' })
  receivedAt?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Người nhập hàng — nhân sự ACTIVE của chi nhánh phiếu (hoặc vai trò toàn chuỗi)' })
  receiverId?: string;

  @IsOptional()
  @IsIn(RECEIPT_PAYMENT_METHODS)
  @ApiPropertyOptional({ enum: RECEIPT_PAYMENT_METHODS, description: 'Hình thức trả NCC (CASH | BANK_TRANSFER)' })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional()
  supplierInvoiceNo?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ example: '2026-10-14' })
  supplierInvoiceDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional({ default: 0, description: 'Giảm giá phiếu theo VND. Không gửi cùng discountPercent.' })
  discountAmount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @ApiPropertyOptional({ description: 'Chiết khấu % trên tiền hàng; server tự tính discountAmount' })
  discountPercent?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional({ default: 0 })
  vatAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional({ default: 0, description: 'Đã trả NCC. paymentStatus do server suy ra.' })
  paidAmount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXPENSES)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptExpenseRequest)
  @ApiPropertyOptional({ type: [GoodsReceiptExpenseRequest], description: `Chi phí nhập, tối đa ${MAX_EXPENSES}` })
  expenses?: GoodsReceiptExpenseRequest[];

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptItemRequest)
  @ApiProperty({ type: [GoodsReceiptItemRequest] })
  items: GoodsReceiptItemRequest[];
}

export class CreateGoodsReceiptRequest extends GoodsReceiptDraftFields {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Chi nhánh nhập. PM/nhân viên bỏ trống = chi nhánh của mình; ADMIN bắt buộc gửi.',
  })
  branchId?: string;
}

/** Sửa phiếu NHÁP = thay toàn bộ (PUT). Không đổi được chi nhánh: muốn nhập chi nhánh khác thì lập phiếu khác. */
export class UpdateGoodsReceiptRequest extends GoodsReceiptDraftFields {}

export class CancelGoodsReceiptRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ example: 'Nhập nhầm số lượng' })
  reason: string;
}

export class UpdateReceiptPaymentRequest {
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiProperty({ description: 'Tổng số đã trả NCC (không phải số trả thêm). Lịch sử thay đổi nằm ở audit_logs.' })
  paidAmount: number;
}
