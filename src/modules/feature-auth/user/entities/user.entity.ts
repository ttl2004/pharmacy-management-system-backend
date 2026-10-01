import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity } from 'typeorm';
import { AuthRole, RecordStatusEnum } from 'src/common/types/common.enum';
import { AbstractBaseEntity } from 'src/providers/abstract-base/abstract-base.entity';

@Entity('users')
export class UserEntity extends AbstractBaseEntity {
  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  phoneNumber: string | null;

  @Column({ type: 'varchar', unique: true })
  @ApiProperty()
  email: string;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  address: string | null;

  @Column({ type: 'varchar' })
  @ApiProperty()
  fullName: string;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  age: string | null;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  gender: string | null;

  @Column({ type: 'varchar', default: RecordStatusEnum.ACTIVE })
  @ApiProperty()
  status: RecordStatusEnum;

  @Column({ type: 'varchar' })
  @ApiProperty({ enum: AuthRole })
  role: AuthRole;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty()
  permissionId: string | null;
}
