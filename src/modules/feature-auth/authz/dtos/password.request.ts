import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordRequest {
  @ApiProperty({ example: 'Mat-khau-hien-tai1' })
  @IsString({ message: '$property phải là chuỗi ký tự' })
  @MaxLength(72, { message: '$property không được vượt quá $constraint1 ký tự' })
  currentPassword: string;

  @ApiProperty({ example: 'Mat-khau-moi-an-toan1', minLength: 8, maxLength: 72 })
  @IsString({ message: '$property phải là chuỗi ký tự' })
  @MinLength(8, { message: '$property phải có ít nhất $constraint1 ký tự' })
  @MaxLength(72, { message: '$property không được vượt quá $constraint1 ký tự' })
  newPassword: string;
}
