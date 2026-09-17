import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AbstractBaseSchema } from 'src/providers/abstract-base/abstract-base.entity';
import { UserDocument } from '../../user/schemas/user.schema';

@Schema({ collection: 'auths', timestamps: true })
export class AuthzDocument extends AbstractBaseSchema {
  @Prop({ type: String })
  @ApiProperty()
  password: string;

  @Prop({ type: String, unique: true, index: true })
  @ApiProperty()
  username: string;

  @Prop({ type: Types.ObjectId, ref: UserDocument.name })
  @ApiProperty()
  userId: Types.ObjectId;
}

export const AuthzSchema = SchemaFactory.createForClass(AuthzDocument);
