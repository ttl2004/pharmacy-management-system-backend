import { Body, Controller, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { BatchStatusService } from './batch-status.service';
import { RecallBatchRequest, UpdateBatchStatusRequest } from './dtos/batch-status.request';

@Controller('stock/batches')
@ApiTags('Stock')
@ApiBearerAuth(AUTH_JWT)
@UseGuards(AuthzGuard, PermissionGuard)
@RequirePermissions('stock-batch:block')
export class BatchStatusController {
  constructor(private readonly batchStatusService: BatchStatusService) {}

  @Post('recall')
  @ApiOperation({ description: 'Thu hồi/khoá theo số lô — ADMIN: mọi chi nhánh; PM: chi nhánh mình.' })
  recall(@Body() dto: RecallBatchRequest, @CurrentActor() actor: RequestActor) {
    return this.batchStatusService.recall(dto, actor);
  }

  @Patch(':id/status')
  @ApiOperation({ description: 'Khoá (QUARANTINE), thu hồi (RECALLED) hoặc mở lại (AVAILABLE) một lô.' })
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBatchStatusRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.batchStatusService.setStatus(id, dto, actor);
  }
}
