import { ApiPropertyOptional } from '@nestjs/swagger';
import { DosageForm, RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

/**
 * `Boolean('false')` trả `true` nên chuỗi query phải chuyển tường minh; giá trị khác `true`/`false`
 * được giữ nguyên để `@IsBoolean` báo lỗi 400 thay vì âm thầm thành `true`.
 */
const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class ProductQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo nhóm sản phẩm' })
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo hãng sản xuất' })
  manufacturerId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo đơn vị cơ bản' })
  baseUnitId?: string;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;

  @IsOptional()
  @IsEnum(DosageForm)
  @ApiPropertyOptional({ enum: DosageForm })
  dosageForm?: DosageForm;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, description: 'Lọc thuốc kê đơn' })
  requiresPrescription?: boolean;
}
