import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { trimUpperCase } from 'src/common/utils/string-transform.util';

/** Trần đầu vào — chặn số vô lý trước khi chạm DB (cột `int` tràn ở ~2,1 tỷ). */
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_PRICE = 1_000_000_000;

/**
 * Một dòng phiếu nhập. KHÔNG có `conversionRate`, `baseQuantity`, `totalPrice`: server tự tính từ `product_units`
 * (whitelist + forbidNonWhitelisted nên client gửi lên là 400).
 */
export class GoodsReceiptItemRequest {
  @IsUUID()
  @ApiProperty()
  productId: string;

  @IsUUID()
  @ApiProperty({ description: 'Đơn vị nhập (thường là Hộp) — phải thuộc đúng productId' })
  productUnitId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY)
  @ApiProperty({ example: 10, description: 'Số lượng theo đơn vị nhập' })
  quantity: number;

  @IsInt()
  @Min(0)
  @Max(MAX_UNIT_PRICE)
  @ApiProperty({ example: 42000, description: 'Giá nhập theo đơn vị nhập, đồng' })
  importPrice: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_UNIT_PRICE)
  @ApiPropertyOptional({ default: 0, description: 'Giảm giá trên MỖI đơn vị nhập, đồng. Không vượt importPrice (1002).' })
  unitDiscount?: number;

  @Transform(trimUpperCase)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty({ example: 'LO2026A' })
  batchNumber: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ example: '2026-01-15' })
  manufacturingDate?: string;

  @IsDateOnly()
  @ApiProperty({ example: '2028-01-15' })
  expiryDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ description: 'Ghi chú dòng' })
  note?: string;
}
