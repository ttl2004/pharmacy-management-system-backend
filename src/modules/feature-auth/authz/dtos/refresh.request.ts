import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenRequest {
  @ApiPropertyOptional({
    description: 'Chỉ nhận khi AUTH_REFRESH_IN_BODY=true và không có cookie',
    example: 'dan-refresh-token-tu-phan-hoi-dang-nhap',
  })
  @IsOptional()
  @IsString({ message: '$property phải là chuỗi ký tự' })
  @MaxLength(256, { message: '$property không được vượt quá $constraint1 ký tự' })
  refreshToken?: string;
}
