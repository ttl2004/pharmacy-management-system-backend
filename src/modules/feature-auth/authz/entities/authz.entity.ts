import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { AbstractBaseEntity } from 'src/providers/abstract-base/abstract-base.entity';
import { UserEntity } from '../../user/entities/user.entity';

@Entity('auths')
export class AuthzEntity extends AbstractBaseEntity {
  @Column({ type: 'varchar' })
  @ApiProperty()
  password: string;

  @Column({ type: 'varchar', unique: true })
  @ApiProperty()
  username: string;

  @Column({ type: 'varchar' })
  @ApiProperty()
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({ name: 'userId' })
  @ApiProperty({ type: () => UserEntity })
  user: UserEntity;
}
