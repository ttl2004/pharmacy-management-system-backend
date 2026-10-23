import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Sửa thông tin phiếu ĐÃ NHẬP: chỉ người nhập, ngày nhập, ghi chú — không đổi tồn/giá vốn/nợ. */
export class UpdateReceiptMetaRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true, description: 'null = bỏ người nhập' })
  receiverId?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  @ApiPropertyOptional({ description: 'Thời điểm nhận hàng (ISO 8601)' })
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ nullable: true, description: 'null = xoá ghi chú' })
  note?: string | null;
}
