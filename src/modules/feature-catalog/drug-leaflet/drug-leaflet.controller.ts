import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../../feature-auth/authz/guards/auth.guard';
import { RequirePermissions } from '../../feature-auth/permission/decorators/require-permissions.decorator';
import { PermissionGuard } from '../../feature-auth/permission/guards/permission.guard';
import { DrugLeafletDraftService } from './drug-leaflet-draft.service';
import { DrugLeafletSaveService } from './drug-leaflet-save.service';
import { SaveDrugLeafletDraftRequest } from './dtos/save-drug-leaflet-draft.request';
import { readLeafletImageParts } from './read-leaflet-image-parts';

/** Bản nháp thuốc từ ảnh tờ HDSD (design §5.4). */
@Controller('drug-leaflet-draft')
@ApiTags('Drug leaflet draft')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({
  status: 400,
  description:
    'Mã lỗi: RECORD_NOT_FOUND (1600), OCR_SERVICE_UNAVAILABLE (1612), DRUG_LEAFLET_IMAGE_REJECTED (1613), ' +
    'DRUG_LEAFLET_DRAFT_CLOSED (1614), DRUG_LEAFLET_DRAFT_NOT_READY (1615), ' +
    'DRUG_REGISTRATION_DUPLICATE_DQG (1616, `details.drugs`), DRUG_REGISTRATION_DUPLICATE_MANUAL (1617, `details.drug`)',
})
@UseGuards(AuthzGuard, PermissionGuard)
export class DrugLeafletController {
  constructor(
    private readonly draftService: DrugLeafletDraftService,
    private readonly saveService: DrugLeafletSaveService,
  ) {}

  @RequirePermissions('product:create')
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['images'],
      properties: { images: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'binary' } } },
    },
  })
  @ApiOperation({
    description:
      'Tải 1-20 ảnh tờ HDSD (JPEG/PNG/WebP/HEIC, mỗi ảnh tối đa 5 MB; gửi nhiều file cùng tên trường `images`). ' +
      'Chuyển sang OCR và tạo bản nháp PROCESSING.',
  })
  create(@Req() request: FastifyRequest, @CurrentActor() actor: RequestActor) {
    return readLeafletImageParts(request).then((files) => this.draftService.create(files, actor));
  }

  @RequirePermissions('product:read')
  @Get()
  @ApiOperation({
    description:
      'Bản nháp đang xử lý/sẵn sàng/lỗi, mới nhất trước. Bản PROCESSING được hỏi lại OCR (timeout 3 giây, OCR lỗi thì giữ trạng thái cũ).',
  })
  list() {
    return this.draftService.list();
  }

  @RequirePermissions('product:read')
  @Get(':id')
  @ApiOperation({ description: 'Chi tiết bản nháp; khi READY có `form` (đã ánh xạ sang form thuốc) và 16 giá trị gốc `raw`.' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.draftService.detail(id);
  }

  /**
   * Trả byte ảnh thô, không bọc envelope: dùng `@Res()` không passthrough nên Nest bỏ qua giá trị trả về
   * (kể cả kết quả của `TransformInterceptor`) và chính handler gửi reply.
   */
  @RequirePermissions('product:read')
  @Get(':id/images/:index')
  @ApiProduces('image/webp')
  @ApiOperation({ description: 'Ảnh WebP của bản nháp (proxy từ OCR, FE không cần khoá OCR).' })
  async image(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', new ParseIntPipe()) index: number,
    @Res() reply: FastifyReply,
  ) {
    const { buffer, contentType } = await this.draftService.image(id, index);
    await reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'private, max-age=300')
      .send(buffer);
  }

  @RequirePermissions('product:create')
  @Post(':id/retry')
  @ApiOperation({ description: 'Chạy lại OCR cho bản nháp FAILED, về PROCESSING.' })
  retry(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.draftService.retry(id, actor);
  }

  @RequirePermissions('product:create')
  @Post(':id/discard')
  @ApiOperation({ description: 'Bỏ bản nháp (không xoá bên OCR).' })
  discard(@Param('id', new ParseUUIDPipe()) id: string, @CurrentActor() actor: RequestActor) {
    return this.draftService.discard(id, actor);
  }

  @RequirePermissions('product:create')
  @Post(':id/save')
  @ApiOperation({
    description:
      'Lưu bản nháp READY: tạo thuốc MANUAL (hoặc ghi đè/liên kết theo `resolution`) và sản phẩm trong một transaction. ' +
      'Trùng số đăng ký trả 1616/1617 kèm `details`; gửi lại với `resolution`. Trả chi tiết sản phẩm như `POST /product`.',
  })
  save(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveDrugLeafletDraftRequest,
    @CurrentActor() actor: RequestActor,
  ) {
    return this.saveService.save(id, dto, actor);
  }
}
