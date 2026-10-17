import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
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
import { trimUpperCase } from 'src/common/utils/string-transform.util';

/** Trần đầu vào — chặn số vô lý trước khi chạm DB (cột `int` tràn ở ~2,1 tỷ). */
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_PRICE = 1_000_000_000;
/** Tiền cấp phiếu: dưới `Number.MAX_SAFE_INTEGER` rất xa, đủ cho mọi phiếu thật. */
const MAX_DOCUMENT_AMOUNT = 1_000_000_000_000;

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
}

export class CreateGoodsReceiptRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Chi nhánh nhập. PM/nhân viên bỏ trống = chi nhánh của mình; ADMIN bắt buộc gửi.',
  })
  branchId?: string;

  @IsUUID()
  @ApiProperty()
  supplierId: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @ApiPropertyOptional({ description: 'Thời điểm nhận hàng thực tế (ISO 8601). Bỏ trống = lúc xác nhận.' })
  receivedAt?: string;

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
  @ApiPropertyOptional({ default: 0 })
  discountAmount?: number;

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

/** Sửa phiếu NHÁP = thay toàn bộ (PUT). Không đổi được chi nhánh: muốn nhập chi nhánh khác thì lập phiếu khác. */
export class UpdateGoodsReceiptRequest {
  @IsUUID()
  @ApiProperty()
  supplierId: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @ApiPropertyOptional()
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional()
  supplierInvoiceNo?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  supplierInvoiceDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional()
  discountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional()
  vatAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DOCUMENT_AMOUNT)
  @ApiPropertyOptional()
  paidAmount?: number;

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
