import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_PAGE, MAX_PAGE_LIMIT } from 'src/providers/abstract-base/abstract-base.query';

export const LEDGER_KINDS = ['RECEIPT', 'PAYMENT', 'ADJUSTMENT'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Query của `GET /supplier-debt/:supplierId/ledger`. */
export class LedgerQuery {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  @ApiPropertyOptional({ example: 1 })
  page: number = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  @ApiPropertyOptional({ example: 10, maximum: MAX_PAGE_LIMIT })
  limit: number = 10;

  @IsOptional()
  @IsIn(LEDGER_KINDS)
  @ApiPropertyOptional({ enum: LEDGER_KINDS, description: 'Lọc SAU khi cộng dồn nên số dư từng dòng vẫn đúng' })
  kind?: LedgerKind;
}

/** Query của `GET /supplier-debt/:supplierId/open-receipts`. */
export class OpenReceiptsQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'ADMIN: xem nợ/phiếu của MỘT chi nhánh. PM/nhân viên: luôn bị ép về chi nhánh mình.' })
  branchId?: string;
}
