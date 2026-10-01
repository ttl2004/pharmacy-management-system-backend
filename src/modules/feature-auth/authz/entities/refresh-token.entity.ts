import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from '../../user/entities/user.entity';

@Entity('refresh_tokens')
@Index(['userId', 'sid'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Index()
  @Column({ type: 'varchar' })
  sid: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  tokenHash: string;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;

  // Giữ cột cũ để tương thích dữ liệu đã xoay vòng; RT mới không sử dụng cột này.
  @Column({ type: 'varchar', nullable: true })
  replacedById: string | null;

  @Column({ type: 'varchar', nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', nullable: true })
  ip: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null;
}
