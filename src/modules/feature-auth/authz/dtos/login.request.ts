import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginRequest {
  @ApiProperty({ description: 'Tên đăng nhập', example: 'admin' })
  @IsString({ message: '$property phải là chuỗi ký tự' })
  @IsNotEmpty({ message: '$property không được để trống' })
  @MaxLength(255, { message: '$property không được vượt quá $constraint1 ký tự' })
  username: string;

  @ApiProperty({ example: 'Mat-khau-cua-ban1' })
  @IsString({ message: '$property phải là chuỗi ký tự' })
  @IsNotEmpty({ message: '$property không được để trống' })
  @MaxLength(1024, { message: '$property không được vượt quá $constraint1 ký tự' })
  password: string;
}
