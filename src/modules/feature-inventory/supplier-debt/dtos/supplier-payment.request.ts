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
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Tiền một dòng phân bổ: dưới `Number.MAX_SAFE_INTEGER` rất xa, đủ cho mọi phiếu thật. */
const MAX_AMOUNT = 1_000_000_000_000;
export const MAX_PAYMENT_ALLOCATIONS = 50;

/** COD không áp dụng cho trả NCC (CHECK trong DB cũng cấm). */
export const SUPPLIER_PAYMENT_METHODS = [PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER];

export class PaymentAllocationRequest {
  @IsUUID()
  @ApiProperty({ description: 'Phiếu nhập CONFIRMED của đúng NCC, mỗi phiếu một lần' })
  receiptId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  @ApiProperty({ description: 'VND, nguyên dương, không vượt số còn nợ của phiếu' })
  amount: number;
}

export class CreateSupplierPaymentRequest {
  @IsUUID()
  @ApiProperty()
  supplierId: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh chi tiền. PM/nhân viên: bỏ trống hoặc chi nhánh mình; ADMIN: bắt buộc' })
  branchId?: string;

  @IsDateString({ strict: true })
  @ApiProperty({ description: 'Thời điểm chi (ISO 8601), không ở tương lai quá 60 giây' })
  paidAt: string;

  @IsIn(SUPPLIER_PAYMENT_METHODS)
  @ApiProperty({ enum: SUPPLIER_PAYMENT_METHODS })
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PAYMENT_ALLOCATIONS)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationRequest)
  @ApiProperty({ type: [PaymentAllocationRequest] })
  allocations: PaymentAllocationRequest[];
}

export class CancelDebtDocumentRequest {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  reason?: string;
}
