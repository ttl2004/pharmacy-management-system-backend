import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

export const EXPENSE_KINDS = ['SUPPLIER', 'OTHER'] as const;
export const EXPENSE_VALUE_TYPES = ['VND', 'PCT'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];
export type ExpenseValueType = (typeof EXPENSE_VALUE_TYPES)[number];

/** Một khoản chi phí nhập (bản chụp). Server tự tính `amount`; PCT tính trên (tiền hàng − giảm giá phiếu). */
export class GoodsReceiptExpenseRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @ApiProperty({ example: 'VANCHUYEN' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({ example: 'Phí vận chuyển' })
  name: string;

  @IsIn(EXPENSE_KINDS)
  @ApiProperty({ enum: EXPENSE_KINDS, description: 'SUPPLIER = cộng vào Cần trả NCC; OTHER = chỉ vào giá vốn' })
  kind: ExpenseKind;

  @IsIn(EXPENSE_VALUE_TYPES)
  @ApiProperty({ enum: EXPENSE_VALUE_TYPES })
  valueType: ExpenseValueType;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  @ApiProperty({ description: 'VND: số nguyên đồng; PCT: 0..100 (tối đa 2 số lẻ)' })
  value: number;
}
