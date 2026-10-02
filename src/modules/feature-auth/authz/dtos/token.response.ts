import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AccessTokenResponse {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;
}

export class TokenResponse extends AccessTokenResponse {
  @ApiPropertyOptional({
    description: 'Chỉ trả khi đăng nhập và AUTH_REFRESH_IN_BODY=true; giữ RT này đến khi hết hạn hoặc phiên bị thu hồi',
    example: 'chuoi-token-ngau-nhien-base64url',
  })
  refreshToken?: string;
}

export class TokenEnvelopeResponse {
  @ApiProperty({ type: TokenResponse }) data: TokenResponse;
  @ApiProperty({ example: 0 }) errorCode: number;
  @ApiProperty({ example: '' }) traceId: string;
}

export class AccessTokenEnvelopeResponse {
  @ApiProperty({ type: AccessTokenResponse }) data: AccessTokenResponse;
  @ApiProperty({ example: 0 }) errorCode: number;
  @ApiProperty({ example: '' }) traceId: string;
}
