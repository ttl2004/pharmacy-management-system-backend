import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** DELETE không có body nên lý do (tuỳ chọn) đi qua query `?reason=`. Ghi vào nhật ký thao tác. */
export class DeleteReasonQuery {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ maxLength: 500, description: 'Lý do xoá (tuỳ chọn)' })
  reason?: string;
}
