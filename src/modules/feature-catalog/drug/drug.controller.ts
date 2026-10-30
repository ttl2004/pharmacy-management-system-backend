import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { DrugService } from './drug.service';
import { DrugQuery, DrugSyncQuery } from './dtos/drug.query';

/** Danh mục thuốc CSDL Dược — chỉ đọc; dữ liệu chỉ vào bằng đồng bộ từ nguồn. Dùng chung toàn chuỗi. */
@Controller('drug')
@ApiTags('Drug')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: RECORD_NOT_FOUND (1600), DRUG_SOURCE_UNAVAILABLE (1607), DRUG_SYNC_IN_PROGRESS (1608), ' +
    'DRUG_SYNC_SUSPICIOUS (1609)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class DrugController {
  constructor(private readonly drugService: DrugService) {}

  @RequirePermissions('drug:read')
  @Get()
  @ApiOperation({
    description: 'Danh sách thuốc, tìm theo mã định danh/tên/thành phần/số đăng ký. Mặc định sắp theo tên.',
  })
  list(@Query() query: DrugQuery) {
    return this.drugService.list(query);
  }

  @RequirePermissions('drug:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết thuốc.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.drugService.getDetail(id);
  }

  @RequirePermissions('drug:sync')
  @Post('sync')
  @ApiOperation({
    description:
      'Đồng bộ toàn bộ danh mục từ nguồn CSDL Dược: thêm/cập nhật theo mã, thuốc không còn trong nguồn chuyển INACTIVE, ' +
      'cờ kê đơn của hàng hoá đã liên kết cập nhật theo danh mục. Chỉ một lần đồng bộ chạy tại một thời điểm (1608). ' +
      'Chuyển INACTIVE quá 10% thuốc đang hoạt động thì từ chối (1609) trừ khi `force=true`.',
  })
  sync(@Query() query: DrugSyncQuery, @CurrentUser() user: JwtUser) {
    return this.drugService.sync(user.userId, query.force ?? false);
  }
}
