import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { UserRepository } from './repositories/user.repository';

@Injectable()
export class UserService extends AbstractBaseService<User> {
  constructor(private readonly userRepository: UserRepository) {
    super(userRepository);
  }
}
