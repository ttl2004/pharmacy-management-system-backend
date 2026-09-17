import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { AuthRole, RecordStatusEnum } from 'src/common/types/common.enum';

export class CreateUserRequest {
  @IsString()
  @ApiProperty()
  phoneNumber: string;

  @IsString()
  @ApiProperty()
  email: string;

  @IsString()
  @ApiProperty()
  fullName: string;

  @IsString()
  @ApiProperty()
  address: string;

  @IsString()
  @ApiProperty()
  age: string;

  @IsString()
  @ApiProperty()
  gender: string;

  @IsString()
  @ApiProperty({ enum: AuthRole })
  role: AuthRole;

  @IsString()
  @ApiProperty({ enum: RecordStatusEnum })
  @IsOptional()
  status: RecordStatusEnum;

  @IsString()
  @ApiProperty()
  @IsOptional()
  permissionId: string;
}

export class UpdateUserRequest extends PartialType(CreateUserRequest) {}
