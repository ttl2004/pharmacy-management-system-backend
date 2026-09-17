import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsMongoId, IsString } from 'class-validator';

export class CreateAuthzRequest {
  @IsString()
  @ApiProperty()
  username: string;

  @IsString()
  @ApiProperty()
  password: string;

  @IsMongoId()
  @ApiProperty({ description: 'Reference to user._id' })
  userId: string;
}

export class UpdateAuthzRequest extends PartialType(CreateAuthzRequest) {}
