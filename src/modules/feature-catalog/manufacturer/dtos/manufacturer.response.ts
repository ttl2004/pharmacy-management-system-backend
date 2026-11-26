import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '@prisma/client';

/** Mô tả Swagger cho bản ghi hãng sản xuất trả về. */
export class ManufacturerResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ example: 'NSX0001', nullable: true, description: 'Tự sinh NSX0001… nếu tạo không nhập mã' })
  code: string | null;

  @ApiProperty({ example: 'Công ty CP Dược phẩm Trung ương I' })
  name: string;

  @ApiPropertyOptional({
    example: 'duoc pham trung uong 1',
    nullable: true,
    description: 'Tên đã chuẩn hoá để so trùng',
  })
  nameKey: string | null;

  @ApiPropertyOptional({ example: 'Việt Nam', nullable: true })
  country: string | null;

  @ApiPropertyOptional({ nullable: true })
  address: string | null;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiProperty({ enum: RecordStatus })
  status: RecordStatus;
}

export class ResolveManufacturerResponse {
  @ApiProperty({ description: 'true nếu vừa tạo hãng mới, false nếu trả hãng có sẵn' })
  created: boolean;

  @ApiProperty({
    type: ManufacturerResponse,
    description: 'Hãng khớp tên chuẩn hoá (ưu tiên ACTIVE). Có thể là INACTIVE nếu chỉ còn hãng ngừng hoạt động.',
  })
  manufacturer: ManufacturerResponse;
}
