import { RolePermissionRepository } from './role-permission.repository';

/** Transaction giả: `findMany` trả các permissionId đã có bản ghi (kể cả bản ghi đã xoá mềm). */
function makeTx(existingPermissionIds: string[]) {
  const findMany = jest.fn().mockResolvedValue(existingPermissionIds.map((permissionId) => ({ permissionId })));
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  return { tx: { rolePermission: { findMany, createMany } } as never, findMany, createMany };
}

describe('RolePermissionRepository.grantMissing', () => {
  const repository = new RolePermissionRepository({} as never);

  it('chỉ tạo cặp chưa từng có bản ghi và trả số quyền vừa cấp', async () => {
    const { tx, createMany } = makeTx(['p1']);

    await expect(repository.grantMissing(tx, 'role-1', ['p1', 'p2'], 'actor')).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledWith({ data: [{ roleId: 'role-1', permissionId: 'p2', createdBy: 'actor' }] });
  });

  it('đọc mọi bản ghi của vai trò, KHÔNG lọc isDeleted — quyền đã thu hồi không bị cấp lại', async () => {
    const { tx, findMany, createMany } = makeTx(['p1', 'p2']);

    await expect(repository.grantMissing(tx, 'role-1', ['p1', 'p2'], 'actor')).resolves.toBe(0);
    expect(findMany).toHaveBeenCalledWith({ where: { roleId: 'role-1' }, select: { permissionId: true } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('bỏ trùng trong danh sách đầu vào', async () => {
    const { tx, createMany } = makeTx([]);

    await expect(repository.grantMissing(tx, 'role-1', ['p1', 'p1'], 'actor')).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledWith({ data: [{ roleId: 'role-1', permissionId: 'p1', createdBy: 'actor' }] });
  });
});
