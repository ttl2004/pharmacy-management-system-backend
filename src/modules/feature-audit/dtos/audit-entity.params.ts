import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

export class AuditEntityParams {
  @Matches(/^[a-z_]{1,50}$/)
  @ApiProperty({ example: 'price_books', description: 'Tên bảng của đối tượng' })
  type!: string;

  @IsUUID()
  @ApiProperty()
  id!: string;
}
