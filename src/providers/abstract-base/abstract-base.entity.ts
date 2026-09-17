import { Prop } from '@nestjs/mongoose';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Document } from 'mongoose';

export class AbstractBaseSchema extends Document {
  @Prop({ type: Boolean, default: false })
  @ApiProperty()
  isDeleted: boolean;

  @Prop({ type: Number, default: Date.now })
  @ApiProperty()
  createdAt: number;

  @Prop({ type: String, nullable: true })
  @ApiProperty()
  createdBy: string;

  @Prop({ type: Number, nullable: true })
  @ApiPropertyOptional()
  updatedAt: number;

  @Prop({ type: String, nullable: true })
  @ApiPropertyOptional()
  updatedBy: string;
}
