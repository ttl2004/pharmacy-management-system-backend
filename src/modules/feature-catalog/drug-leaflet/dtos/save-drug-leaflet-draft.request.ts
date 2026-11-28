import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { CreateProductRequest } from '../../product/dtos/product.request';
import { DuplicateResolutionRequest, ManualDrugInput } from './manual-drug.request';

/**
 * Lưu bản nháp (design §5.6): payload tạo sản phẩm như `POST /product` nhưng không có `drugId` (thuốc lấy từ khối `drug`
 * hoặc từ `resolution`), kèm số sao chấm chất lượng đọc ảnh.
 */
export class SaveDrugLeafletDraftRequest extends OmitType(CreateProductRequest, ['drugId'] as const) {
  @ValidateNested()
  @Type(() => ManualDrugInput)
  @ApiProperty({ type: ManualDrugInput, description: 'Thông tin thuốc đã duyệt (kể cả khi liên kết DQG, để gửi feedback)' })
  drug: ManualDrugInput;

  @IsInt()
  @Min(1)
  @Max(5)
  @ApiProperty({ minimum: 1, maximum: 5, description: 'Chấm sao kết quả đọc ảnh, bắt buộc' })
  rating: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DuplicateResolutionRequest)
  @ApiPropertyOptional({
    type: DuplicateResolutionRequest,
    description: 'Gửi lại sau lỗi trùng số đăng ký: LINK_DQG (gắn thuốc DQG) hoặc OVERWRITE_MANUAL (ghi đè thuốc nhập tay)',
  })
  resolution?: DuplicateResolutionRequest;
}
