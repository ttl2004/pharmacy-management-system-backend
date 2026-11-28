import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import {
  CreateManufacturerRequest,
  ResolveManufacturerRequest,
  UpdateManufacturerRequest,
} from './dtos/manufacturer.request';
import { ResolveManufacturerResponse } from './dtos/manufacturer.response';
import { ManufacturerQuery } from './dtos/manufacturer.query';
import { ManufacturerService } from './manufacturer.service';

@Controller('manufacturer')
@ApiTags('Manufacturer')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: RECORD_NOT_FOUND (1600), DUPLICATE_CODE (1601 — trùng mã, hoặc "Hãng đã tồn tại: <tên>"), ' +
    'INVALID_REFERENCE (1602), HTTP_BAD_REQUEST (1002 — tên không có chữ/số)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class ManufacturerController {
  constructor(private readonly manufacturerService: ManufacturerService) {}

  @RequirePermissions('manufacturer:read')
  @Get()
  @ApiOperation({ description: 'Danh sách hãng sản xuất, tìm theo mã/tên/quốc gia, lọc theo trạng thái.' })
  list(@Query() query: ManufacturerQuery) {
    return this.manufacturerService.list(query);
  }

  // Khai báo trước `:id` để "countries" không bị ParseUUIDPipe bắt.
  @RequirePermissions('manufacturer:read')
  @Get('countries')
  @ApiOperation({
    description: 'Danh sách quốc gia chuẩn (tiếng Việt) cho ô chọn quốc gia của hãng. "Việt Nam" đứng đầu.',
  })
  @ApiOkResponse({ schema: { type: 'array', items: { type: 'string' }, example: ['Việt Nam', 'Ai Cập', 'Anh'] } })
  countries() {
    return this.manufacturerService.listCountries();
  }

  @RequirePermissions('manufacturer:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết hãng sản xuất.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.manufacturerService.getDetail(id);
  }

  @RequirePermissions('manufacturer:create')
  @Post()
  @ApiOperation({
    description:
      'Tạo hãng sản xuất. Không nhập mã → tự sinh NSX0001… Quốc gia được đưa về tên chuẩn ("VN" → "Việt Nam"). ' +
      'Tên trùng (sau chuẩn hoá) với hãng chưa xoá → DUPLICATE_CODE "Hãng đã tồn tại: <tên>".',
  })
  create(@Body() dto: CreateManufacturerRequest, @CurrentActor() actor: RequestActor) {
    return this.manufacturerService.create(dto, actor);
  }

  @RequirePermissions('manufacturer:create')
  @Post('resolve')
  @ApiOperation({
    description:
      'Tìm-hoặc-tạo hãng theo tên chuẩn hoá (bỏ dấu, thường hoá, bỏ "Công ty/CTCP/TNHH/Co., Ltd…", I→1 cuối tên). ' +
      'Nguyên tử: hai request đồng thời cùng tên (kể cả biến thể) chỉ tạo một hãng. Ưu tiên hãng ACTIVE; ' +
      'hãng có sẵn giữ nguyên quốc gia. Tạo mới thì tự sinh mã NSX… và chuẩn hoá quốc gia.',
  })
  @ApiOkResponse({ type: ResolveManufacturerResponse })
  resolve(@Body() dto: ResolveManufacturerRequest, @CurrentActor() actor: RequestActor) {
    return this.manufacturerService.resolve(dto, actor);
  }

  @RequirePermissions('manufacturer:update')
  @Patch(':id')
  @ApiOperation({
    description:
      'Sửa hãng sản xuất. Gửi null cho country/address/note để xoá giá trị cũ. Đổi tên trùng hãng khác → DUPLICATE_CODE.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateManufacturerRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.manufacturerService.update(id, dto, actor);
  }

  @RequirePermissions('manufacturer:delete')
  @Delete(':id')
  @ApiOperation({ description: 'Xoá mềm hãng sản xuất. Từ chối nếu còn sản phẩm tham chiếu.' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.manufacturerService.remove(id, actor);
  }
}
