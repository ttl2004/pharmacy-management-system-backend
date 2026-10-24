import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderChannel, OrderStatus, PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VIETNAM_PHONE_PATTERN } from 'src/common/utils/phone.util';
import { toVietnamPhone } from 'src/common/utils/string-transform.util';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from '../../core/sales.constants';

/** Một dòng đơn: chỉ đơn vị bán và số lượng. Giá, tên, lô do server tự lấy. */
export class OrderItemRequest {
  @IsUUID()
  @ApiProperty({ description: 'Đơn vị bán (product_units.id) — Viên, Hộp…' })
  productUnitId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  @ApiProperty({ example: 2 })
  quantity: number;
}

export class PrescriptionRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty({ example: 'DT-2026-0001' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @ApiProperty({ example: 'BS. Nguyễn Văn A' })
  prescriberName: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(1000)
  @ApiPropertyOptional({ description: 'Ảnh chụp đơn thuốc' })
  imageUrl?: string;
}

/** Dược sĩ ghi đè cảnh báo tương tác major (đã xác thực mật khẩu ở FE). Server tự điền người ghi đè + thời điểm. */
export class InteractionOverrideRequest {
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  @ApiProperty({ description: 'Lý do ghi đè (≥ 20 ký tự)' })
  reason: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ApiProperty({ type: [String] })
  warningIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @ApiProperty({ type: [String], description: 'Mô tả ngắn từng cảnh báo — giữ lại khi cơ sở tri thức đổi' })
  warningSummaries: string[];
}

class OrderLinesRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemRequest)
  @ApiProperty({ type: [OrderItemRequest] })
  items: OrderItemRequest[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PrescriptionRequest)
  @ApiPropertyOptional({ type: PrescriptionRequest, description: 'Bắt buộc trước khi thu tiền nếu có thuốc kê đơn' })
  prescription?: PrescriptionRequest;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  @ApiPropertyOptional({ description: 'Giảm giá cả đơn (VND, ≤ tạm tính). Sửa đơn: không gửi = 0' })
  discountAmount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => InteractionOverrideRequest)
  @ApiPropertyOptional({ type: InteractionOverrideRequest })
  interactionOverride?: InteractionOverrideRequest;
}

export class CreatePosOrderRequest extends OrderLinesRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bảng giá áp cho đơn/giỏ. Bỏ trống = Bảng giá chung' })
  priceBookId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh bán. PM/SS bỏ trống = chi nhánh mình; ADMIN bắt buộc.' })
  branchId?: string;

  @IsOptional()
  @Transform(toVietnamPhone)
  @Matches(VIETNAM_PHONE_PATTERN, { message: 'customerPhone phải là SĐT Việt Nam' })
  @ApiPropertyOptional({
    example: '0912345678',
    description:
      'SĐT người mua. Chưa có hồ sơ thì hệ thống tự tạo (không có tài khoản đăng nhập). Bỏ trống = khách lẻ.',
  })
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @ApiPropertyOptional({ example: 'Chị Mai', description: 'Chỉ dùng khi SĐT chưa có hồ sơ; đã có thì giữ tên cũ' })
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ApiPropertyOptional()
  note?: string;
}

/** Thay TOÀN BỘ dòng đơn (luật S3). `prescription` gửi thì ghi đè, không gửi thì giữ nguyên. */
export class ReplaceOrderItemsRequest extends OrderLinesRequest {}

export class PayOrderRequest {
  @IsIn([PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER, PaymentMethod.CARD])
  @ApiProperty({ enum: [PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER, PaymentMethod.CARD] })
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Mã tham chiếu chuyển khoản — trùng mã đã ghi → 1601' })
  transactionCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional()
  note?: string;
}

/** Xem trước lô FEFO cho giỏ hàng (không giữ hàng). */
export class PreviewAllocationRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bảng giá áp cho đơn/giỏ. Bỏ trống = Bảng giá chung' })
  priceBookId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh bán. PM/SS bỏ trống = chi nhánh mình; ADMIN bắt buộc.' })
  branchId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemRequest)
  @ApiProperty({ type: [OrderItemRequest] })
  items: OrderItemRequest[];
}

export class CancelOrderRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ example: 'Khách đổi ý' })
  reason: string;
}

export class OrderQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN lọc theo chi nhánh; PM/SS chỉ được chi nhánh mình' })
  branchId?: string;

  @IsOptional()
  @IsEnum(OrderChannel)
  @ApiPropertyOptional({ enum: OrderChannel })
  channel?: OrderChannel;

  @IsOptional()
  @IsEnum(OrderStatus)
  @ApiPropertyOptional({ enum: OrderStatus })
  status?: OrderStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional()
  toDate?: string;
}

/**
 * Tra hàng cho màn bán tại quầy. Một API cho cả hai chế độ: bán nhanh (quét `barcode` hoặc gõ `search`) và bán thường
 * (lưới sản phẩm, lọc `categoryId`). Có `barcode` thì bỏ qua `search`/`categoryId`.
 */
export class PosProductQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bảng giá áp cho đơn/giỏ. Bỏ trống = Bảng giá chung' })
  priceBookId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh bán. PM/SS bỏ trống = chi nhánh mình; ADMIN bắt buộc.' })
  branchId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiPropertyOptional({ description: 'Mã vạch vừa quét — khớp chính xác mã của sản phẩm hoặc của một đơn vị bán' })
  barcode?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo danh mục (lưới sản phẩm của chế độ bán thường)' })
  categoryId?: string;
}
