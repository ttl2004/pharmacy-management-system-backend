import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReceiptStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsDateOnly } from 'src/common/validators/is-date-only.validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';

/** Danh sách phân tách dấu phẩy → mảng (quy ước FE `csv`). */
const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;

export class GoodsReceiptQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'PM/nhân viên: bỏ trống hoặc đúng chi nhánh mình; khác → 1506' })
  branchId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Người tạo phiếu' })
  createdBy?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Người nhập hàng' })
  receiverId?: string;

  @IsOptional()
  @IsEnum(ReceiptStatus)
  @ApiPropertyOptional({ enum: ReceiptStatus })
  status?: ReceiptStatus;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Lập từ ngày (giờ VN), YYYY-MM-DD' })
  fromDate?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ description: 'Lập đến hết ngày (giờ VN), YYYY-MM-DD' })
  toDate?: string;

  // --- Lọc nhiều giá trị (csv, như FE) — thắng các trường một giá trị ở trên ---
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsEnum(ReceiptStatus, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Nhiều trạng thái (csv)' })
  statuses?: ReceiptStatus[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Người tạo (csv)' })
  createdByIds?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Người nhập (csv)' })
  receiverIds?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Mã chi phí nhập (trả NCC) có trên phiếu (csv)' })
  expenseCodes?: string[];

  @IsOptional()
  @IsIn(['createdAt', 'receivedAt'])
  @ApiPropertyOptional({ enum: ['createdAt', 'receivedAt'], description: 'fromDate/toDate theo ngày lập (mặc định) hay ngày nhập' })
  dateBy?: 'createdAt' | 'receivedAt';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ description: 'Số hoá đơn đầu vào chứa' })
  invoiceNo?: string;

  // --- Tìm nâng cao (KiotViet) ---
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Mã/tên hàng có trong phiếu' })
  productQ?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Mã/tên nhà cung cấp chứa' })
  supplierQ?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ description: 'Số lô chứa, hoặc HSD dd/mm/yyyy' })
  lotQ?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Ghi chú phiếu chứa' })
  noteQ?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Ghi chú dòng hàng chứa' })
  itemNoteQ?: string;
}

/** Query của `GET /goods-receipt/receivers`. */
export class ReceiversQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh cần liệt kê người nhập. PM/nhân viên: luôn bị ép về chi nhánh mình.' })
  branchId?: string;
}
