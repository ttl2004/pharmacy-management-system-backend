import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Gender, UserStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthRole } from 'src/common/types/common.enum';

export class CreateUserRequest {
  /** SĐT là định danh gốc, nhưng khách tạo từ quầy có thể chưa để lại. */
  @IsOptional()
  @IsString()
  @MaxLength(15)
  @ApiProperty({ required: false, example: '0900000000' })
  phoneNumber?: string;

  /** Khách mua tại quầy không có email — cột cho phép null. */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiProperty({ required: false })
  email?: string;

  @IsString()
  @MaxLength(150)
  @ApiProperty()
  fullName: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false })
  address?: string;

  @IsOptional()
  @IsDateString()
  @ApiProperty({ required: false, example: '1996-01-01', description: 'Định dạng YYYY-MM-DD' })
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

  @IsOptional()
  @IsEnum(UserStatus)
  @ApiProperty({ enum: UserStatus, required: false })
  status?: UserStatus;
}

export class UpdateUserRequest extends PartialType(CreateUserRequest) {}
