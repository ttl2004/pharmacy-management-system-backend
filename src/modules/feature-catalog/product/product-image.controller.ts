import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { ProductImageService } from './product-image.service';

/** 2MB nhị phân ≈ 2.8MB base64 — chặn sớm ở DTO trước khi giải mã. */
const MAX_DATA_URL_LENGTH = 2_800_064;

export class UploadProductImageRequest {
  @IsString()
  @MaxLength(MAX_DATA_URL_LENGTH)
  @ApiProperty({ description: 'data:image/<png|jpeg|webp|gif>;base64,…, tối đa 2MB' })
  dataUrl: string;
}

@Controller('product-image')
@ApiTags('Product')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class ProductImageController {
  constructor(private readonly productImageService: ProductImageService) {}

  @RequirePermissions('product:create')
  @Post()
  @ApiOperation({
    description: 'Tải một ảnh sản phẩm; trả `url` (/uploads/products/…) để ghi vào imageUrls khi tạo/sửa sản phẩm.',
  })
  upload(@Body() dto: UploadProductImageRequest) {
    return this.productImageService.save(dto.dataUrl);
  }
}
