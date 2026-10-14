import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { BranchProductService } from './branch-product.service';
import {
  BranchProductQuery,
  BranchProductTargetQuery,
  UpsertBranchProductRequest,
} from './dtos/branch-product.request';

@Controller('branch-product')
@ApiTags('BranchProduct')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
export class BranchProductController {
  constructor(private readonly branchProductService: BranchProductService) {}

  @RequirePermissions('branch-product:read')
  @Get()
  @ApiOperation({ description: 'Ngưỡng tồn riêng theo chi nhánh. Sản phẩm không có dòng = dùng ngưỡng chung.' })
  list(@Query() query: BranchProductQuery, @CurrentActor() actor: RequestActor) {
    return this.branchProductService.list(query, actor);
  }

  @RequirePermissions('branch-product:update')
  @Put()
  @ApiOperation({ description: 'Đặt/sửa ngưỡng tồn của một sản phẩm tại chi nhánh.' })
  upsert(@Body() dto: UpsertBranchProductRequest, @CurrentActor() actor: RequestActor) {
    return this.branchProductService.upsert(dto, actor);
  }

  @RequirePermissions('branch-product:update')
  @Delete(':productId')
  @ApiOperation({ description: 'Bỏ ngưỡng riêng, quay về ngưỡng chung của sản phẩm.' })
  remove(
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query() query: BranchProductTargetQuery,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.branchProductService.remove(productId, query.branchId, actor);
  }
}
