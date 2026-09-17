import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { AuthRole, RecordStatusEnum } from 'src/common/types/common.enum';
import { AbstractBaseSchema } from 'src/providers/abstract-base/abstract-base.entity';

@Schema({ timestamps: true, collection: 'users' })
export class UserDocument extends AbstractBaseSchema {
  @Prop({ type: String })
  @ApiProperty()
  phoneNumber: string;

  @Prop({ type: String, unique: true, index: true })
  @ApiProperty()
  email: string;

  @Prop({ type: String })
  @ApiProperty()
  address: string;

  @Prop({ type: String })
  @ApiProperty()
  fullName: string;

  @Prop({ type: String })
  @ApiProperty()
  age: string;

  @Prop({ type: String })
  @ApiProperty()
  gender: string;

  @Prop({ type: String, enum: RecordStatusEnum })
  @ApiProperty()
  status: RecordStatusEnum;

  @Prop({ type: String, enum: AuthRole })
  @ApiProperty({
    enum: AuthRole,
  })
  role: AuthRole;

  @Prop({ type: String })
  @ApiProperty()
  permissionId: string;
}

export const UserSchema = SchemaFactory.createForClass(UserDocument);
