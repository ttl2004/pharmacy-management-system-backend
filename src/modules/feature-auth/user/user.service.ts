import { Injectable } from '@nestjs/common';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { UserRepository } from './repositories/user.repository';
import { UserDocument } from './schemas/user.schema';

@Injectable()
export class UserService extends AbstractBaseService<UserDocument> {
  constructor(private readonly userRepository: UserRepository) {
    super(userRepository);
  }
}
