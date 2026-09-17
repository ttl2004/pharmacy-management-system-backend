import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MongooseBaseRepository } from 'src/providers/abstract-base/repositories/mongoose-base.repository';
import { UserDocument } from '../schemas/user.schema';

@Injectable()
export class UserRepository extends MongooseBaseRepository<UserDocument> {
  constructor(
    @InjectModel(UserDocument.name)
    model: Model<UserDocument>,
  ) {
    super(model);
  }
}
