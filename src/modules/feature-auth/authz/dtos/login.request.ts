import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class LoginRequest {
  @ApiProperty({ description: 'Username đăng nhập' })
  @IsString()
  username: string;

  @ApiProperty()
  @IsString()
  password: string;
}
