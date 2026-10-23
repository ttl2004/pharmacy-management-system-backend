import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const MAX_DEBT = 1_000_000_000_000;

export class CreateSupplierDebtAdjustmentRequest {
  @IsUUID()
  @ApiProperty()
  supplierId: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM/nhân viên: bỏ trống hoặc chi nhánh mình (khác → 1506); ADMIN: bắt buộc' })
  branchId?: string;

  @IsDateString({ strict: true })
  @ApiProperty({ description: 'Ngày điều chỉnh (ISO 8601), không ở tương lai' })
  adjustedAt: string;

  @IsInt()
  @Min(0)
  @Max(MAX_DEBT)
  @ApiProperty({
    description:
      'Nợ của CHI NHÁNH điều chỉnh SAU điều chỉnh (VND). Server tự tính chênh lệch từ nợ chi nhánh; bằng nhau → 1002',
  })
  debtAfter: number;

  @IsInt()
  @Min(-MAX_DEBT)
  @Max(MAX_DEBT)
  @ApiProperty({
    description:
      'Nợ của chi nhánh điều chỉnh mà người dùng đã thấy (VND). Khác nợ thật lúc ghi → 1715, phải tải lại rồi thử lại',
  })
  expectedDebtBefore: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ description: 'Lý do điều chỉnh' })
  note: string;
}
