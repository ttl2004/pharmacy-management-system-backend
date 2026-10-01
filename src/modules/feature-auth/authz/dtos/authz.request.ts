import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class CreateAuthzRequest {
  @IsString()
  @ApiProperty()
  username: string;

  @IsString()
  @ApiProperty()
  password: string;

  @IsUUID()
  @ApiProperty({ description: 'Tham chiếu đến user.id' })
  userId: string;
}

export class UpdateAuthzRequest extends PartialType(CreateAuthzRequest) {}
