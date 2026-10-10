import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, UserStatus } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import { AuthRole } from 'src/common/types/common.enum';

/** Ngày sinh chỉ nhận `YYYY-MM-DD` — khớp cách service dựng mốc UTC nửa đêm. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateUserRequest {
  /** SĐT là định danh gốc của mọi tài khoản — cột cho phép null để không vỡ dữ liệu cũ, nhưng API bắt buộc. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(15)
  @ApiProperty({ example: '0900000000' })
  phoneNumber: string;

  /** Khách mua tại quầy không có email — cột cho phép null. */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiProperty({ required: false })
  email?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @ApiProperty()
  fullName: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false })
  address?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'dateOfBirth phải có dạng YYYY-MM-DD' })
  @ApiProperty({ required: false, example: '1996-01-01' })
  dateOfBirth?: string;

  @IsOptional()
  @IsEnum(Gender)
  @ApiProperty({ enum: Gender, required: false })
  gender?: Gender;

  /** Nhân viên thuộc chi nhánh nào; khách hàng để trống. */
  @IsOptional()
  @IsUUID()
  @ApiProperty({ required: false })
  branchId?: string;

  @IsString()
  @ApiProperty({ enum: AuthRole, example: 'SALES_STAFF' })
  roleCode: AuthRole;

  /** Phải đi cùng `password` — gửi lẻ một trong hai là lỗi 1002. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiProperty({ required: false, description: 'Tạo kèm tài khoản đăng nhập' })
  username?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false })
  password?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  @ApiProperty({ enum: UserStatus, required: false })
  status?: UserStatus;
}

/**
 * DTO sửa hồ sơ. Cố ý viết tay thay vì `PartialType(CreateUserRequest)`:
 *
 * - `PartialType` gắn `@IsOptional()` cho mọi trường, mà `@IsOptional()` bỏ qua cả `null` — nên
 *   `{"status": null}` lọt xuống service rồi ném lỗi ở cột NOT NULL thành **500**, còn
 *   `{"phoneNumber": null}` **xoá mất SĐT định danh** và trả 200. Hai trường đó dùng `@ValidateIf`
 *   để phân biệt "không gửi" (bỏ qua) với "gửi null" (400).
 * - Ba trường `roleCode`/`username`/`password` **không** thuộc route này. Để chúng trong DTO là
 *   quảng cáo trên Swagger rồi bỏ qua im lặng — người gọi tưởng đã đổi được. Đường thật:
 *   `PATCH /permission/users/:userId/role` và `POST /auth/change-password`.
 */
export class UpdateUserRequest {
  /** Không được để null — SĐT là định danh gốc. */
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(15)
  @ApiPropertyOptional({ example: '0900000000' })
  phoneNumber?: string;

  /** Không được để null — cột enum là NOT NULL. */
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(UserStatus)
  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;

  /** Không được để null — cột NOT NULL. */
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @ApiPropertyOptional()
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiPropertyOptional({ nullable: true })
  email?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true })
  address?: string | null;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'dateOfBirth phải có dạng YYYY-MM-DD' })
  @ApiPropertyOptional({ example: '1996-01-01', nullable: true })
  dateOfBirth?: string | null;

  @IsOptional()
  @IsEnum(Gender)
  @ApiPropertyOptional({ enum: Gender, nullable: true })
  gender?: Gender | null;

  /** Gửi `null` là hợp lệ với ADMIN/CUSTOMER, nhưng bị từ chối với vai trò bắt buộc có chi nhánh. */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true })
  branchId?: string | null;
}
