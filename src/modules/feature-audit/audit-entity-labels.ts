import { PrismaClient } from '@prisma/client';

type Ref = { entityType: string; entityId: string };
type Loader = (prisma: PrismaClient, ids: string[]) => Promise<{ id: string; label: string }[]>;

const byCode = (rows: { id: string; code: string }[]) => rows.map((r) => ({ id: r.id, label: r.code }));

/**
 * Nhãn đọc được theo `entityType` (tên bảng). Nhật ký chỉ lưu id; tra lúc đọc để log cũ cũng có tên/mã. Không lọc
 * xoá mềm: đối tượng đã xoá vẫn là chủ thể của dòng log.
 */
const LOADERS: Record<string, Loader> = {
  products: async (p, ids) =>
    (await p.product.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })).map(
      (r) => ({ id: r.id, label: `${r.code} · ${r.name}` }),
    ),
  categories: async (p, ids) =>
    (await p.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((r) => ({
      id: r.id,
      label: r.name,
    })),
  suppliers: async (p, ids) =>
    (await p.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })).map(
      (r) => ({ id: r.id, label: `${r.code} · ${r.name}` }),
    ),
  supplier_groups: async (p, ids) =>
    (await p.supplierGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((r) => ({
      id: r.id,
      label: r.name,
    })),
  goods_receipts: async (p, ids) =>
    byCode(await p.goodsReceipt.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  stock_transfers: async (p, ids) =>
    byCode(await p.stockTransfer.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  stock_adjustments: async (p, ids) =>
    byCode(await p.stockAdjustment.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  supplier_payments: async (p, ids) =>
    byCode(await p.supplierPayment.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  supplier_debt_adjustments: async (p, ids) =>
    byCode(await p.supplierDebtAdjustment.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  orders: async (p, ids) => byCode(await p.order.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })),
  users: async (p, ids) =>
    (await p.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((r) => ({
      id: r.id,
      label: r.fullName,
    })),
  stock_batches: async (p, ids) =>
    (
      await p.stockBatch.findMany({
        where: { id: { in: ids } },
        select: { id: true, batchNumber: true, product: { select: { code: true } } },
      })
    ).map((r) => ({ id: r.id, label: `${r.product.code} · lô ${r.batchNumber}` })),
  branch_products: async (p, ids) =>
    (
      await p.branchProduct.findMany({
        where: { id: { in: ids } },
        select: { id: true, product: { select: { code: true, name: true } } },
      })
    ).map((r) => ({ id: r.id, label: `${r.product.code} · ${r.product.name}` })),
};

/** `entityId` → nhãn. Loại chưa biết bỏ qua (FE hiện id rút gọn). */
export async function resolveAuditLabels(prisma: PrismaClient, refs: readonly Ref[]): Promise<Map<string, string>> {
  const idsByType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!LOADERS[r.entityType]) continue;
    const set = idsByType.get(r.entityType) ?? new Set<string>();
    set.add(r.entityId);
    idsByType.set(r.entityType, set);
  }
  const groups = await Promise.all([...idsByType].map(([type, ids]) => LOADERS[type](prisma, [...ids])));
  return new Map(groups.flat().map((g) => [g.id, g.label]));
}
