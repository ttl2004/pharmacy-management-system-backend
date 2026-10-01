import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Base entity dùng chung cho mọi bảng.
 *
 * `createdAt` / `updatedAt` là epoch milliseconds (kiểu `number`) để tiện so sánh và
 * tính toán trong code. Khi ra tới client, `TransformInterceptor` chuyển chúng sang
 * chuỗi ISO 8601 (xem `common/utils/date.util.ts`). `createdAt` do repository gán
 * trong `create()` chứ không dùng default ở tầng DB.
 */
export abstract class AbstractBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty()
  id: string;

  @Column({ type: 'boolean', default: false })
  @ApiProperty()
  isDeleted: boolean;

  @Column({ type: 'integer' })
  @ApiProperty({ type: String, format: 'date-time', example: '2026-09-29T07:30:00.000Z' })
  createdAt: number;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  createdBy: string | null;

  @Column({ type: 'integer', nullable: true })
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: '2026-09-29T07:30:00.000Z' })
  updatedAt: number | null;

  @Column({ type: 'varchar', nullable: true })
  @ApiPropertyOptional()
  updatedBy: string | null;
}
