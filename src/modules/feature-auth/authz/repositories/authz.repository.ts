import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MongooseBaseRepository } from 'src/providers/abstract-base/repositories/mongoose-base.repository';
import { AuthzDocument } from '../schemas/authz.schema';

@Injectable()
export class AuthzRepository extends MongooseBaseRepository<AuthzDocument> {
  constructor(
    @InjectModel(AuthzDocument.name)
    model: Model<AuthzDocument>,
  ) {
    super(model);
  }
}
