import { Injectable } from '@nestjs/common';
import { Branch } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class BranchRepository extends PrismaBaseRepository<Branch> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Branch');
  }

  /**
   * Đếm người dùng còn trỏ tới chi nhánh, **kể cả** người dùng đã xoá mềm — cố ý không lọc
   * `isDeleted`, vì xoá mềm không giải phóng quan hệ và bản ghi đó vẫn có thể được khôi phục.
   */
  countReferencingUsers(branchId: string): Promise<number> {
    return this.prisma.user.count({ where: { branchId } });
  }
}
