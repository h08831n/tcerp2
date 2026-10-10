import {
  describeIntegration,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator';
import { LoadingController } from './loading.controller';
import { InventoryController } from '../inventory/inventory.controller';
import { ApprovalsController } from '../approvals/approvals.controller';
import { PurchaseController } from '../purchase/purchase.controller';
import { GoodsReceiptController } from '../goods-receipt/goods-receipt.controller';

/**
 * p6-12 permissions: the Phase 6 permission catalog is seeded, the system
 * roles carry the ratified grants (salesperson → loading view/create/edit;
 * sales_manager → confirm + driver-info release + approvals.decide; admin →
 * ALL) and every Phase 6 route declares its @RequirePermissions metadata
 * (enforced by the global PermissionsGuard).
 */
describeIntegration('p6-12 permissions', () => {
  const prisma = integrationPrisma();

  it('the Phase 6 permission catalog is seeded', async () => {
    const codes = (
      await prisma.permission.findMany({
        where: {
          code: {
            in: [
              'loading.view', 'loading.create', 'loading.edit', 'loading.confirm', 'loading.cancel',
              'loading.reverse', 'loading.driver_info.release', 'loading.view_all',
              'inventory.view', 'inventory.warehouses.manage',
              'approvals.decide',
              'goods_receipt.view', 'goods_receipt.create', 'goods_receipt.edit',
              'goods_receipt.confirm', 'goods_receipt.reverse',
            ],
          },
        },
        select: { code: true },
      })
    ).map((p) => p.code);
    expect(codes).toHaveLength(16);
  });

  it('salesperson: loading view/create/edit — NOT confirm/cancel/release', async () => {
    const salesperson = await prisma.role.findUniqueOrThrow({ where: { code: 'salesperson' } });
    const codes = (
      await prisma.rolePermission.findMany({
        where: { roleId: salesperson.id, permission: { code: { startsWith: 'loading.' } } },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(codes).toEqual(['loading.create', 'loading.edit', 'loading.view']);
  });

  it('sales_manager: confirm + driver-info release + approvals.decide (+ view_all scope)', async () => {
    const manager = await prisma.role.findUniqueOrThrow({ where: { code: 'sales_manager' } });
    const codes = (
      await prisma.rolePermission.findMany({
        where: { roleId: manager.id },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code);
    for (const code of [
      'loading.view', 'loading.create', 'loading.edit', 'loading.confirm', 'loading.cancel',
      'loading.driver_info.release', 'loading.view_all', 'approvals.decide', 'inventory.view',
    ]) {
      expect(codes).toContain(code);
    }
  });

  it('buyer keeps the purchase-side loading view/create (no confirm)', async () => {
    const buyer = await prisma.role.findUniqueOrThrow({ where: { code: 'buyer' } });
    const codes = (
      await prisma.rolePermission.findMany({
        where: { roleId: buyer.id, permission: { code: { startsWith: 'loading.' } } },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(codes).toEqual(['loading.create', 'loading.view']);
  });

  it('goods receipts: buyer registers, purchase_manager confirms/reverses (Integrity Gate #9)', async () => {
    const buyer = await prisma.role.findUniqueOrThrow({ where: { code: 'buyer' } });
    const buyerCodes = (
      await prisma.rolePermission.findMany({
        where: { roleId: buyer.id, permission: { code: { startsWith: 'goods_receipt.' } } },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(buyerCodes).toEqual(['goods_receipt.create', 'goods_receipt.edit', 'goods_receipt.view']);

    const manager = await prisma.role.findUniqueOrThrow({ where: { code: 'purchase_manager' } });
    const managerCodes = (
      await prisma.rolePermission.findMany({
        where: { roleId: manager.id, permission: { code: { in: ['goods_receipt.reverse', 'loading.reverse'] } } },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(managerCodes).toEqual(['goods_receipt.reverse', 'loading.reverse']);

    const salesperson = await prisma.role.findUniqueOrThrow({ where: { code: 'salesperson' } });
    const salespersonReversal = await prisma.rolePermission.count({
      where: { roleId: salesperson.id, permission: { code: { in: ['goods_receipt.reverse', 'loading.reverse'] } } },
    });
    expect(salespersonReversal).toBe(0);
  });

  it('admin holds everything (ALL)', async () => {
    const admin = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' } });
    const total = await prisma.permission.count();
    const links = await prisma.rolePermission.count({ where: { roleId: admin.id } });
    expect(links).toBeGreaterThanOrEqual(total);
  });

  it('every Phase 6 route declares its required permissions', () => {
    const requiredOf = (target: object, method: string): string[] =>
      Reflect.getMetadata(PERMISSIONS_KEY, target[method as keyof typeof target] as object) ?? [];

    // Loading
    expect(requiredOf(LoadingController.prototype, 'list')).toEqual(['loading.view']);
    expect(requiredOf(LoadingController.prototype, 'getById')).toEqual(['loading.view']);
    expect(requiredOf(LoadingController.prototype, 'create')).toEqual(['loading.create']);
    expect(requiredOf(LoadingController.prototype, 'update')).toEqual(['loading.edit']);
    expect(requiredOf(LoadingController.prototype, 'delete')).toEqual(['loading.cancel']);
    expect(requiredOf(LoadingController.prototype, 'cancel')).toEqual(['loading.cancel']);
    expect(requiredOf(LoadingController.prototype, 'confirm')).toEqual(['loading.confirm']);
    expect(requiredOf(LoadingController.prototype, 'reverse')).toEqual(['loading.reverse']);
    expect(requiredOf(LoadingController.prototype, 'releaseDriverInfo')).toEqual(['loading.driver_info.release']);
    expect(requiredOf(LoadingController.prototype, 'rejectDriverInfo')).toEqual(['loading.driver_info.release']);
    expect(requiredOf(LoadingController.prototype, 'listRelations')).toEqual(['loading.view']);

    // Inventory
    expect(requiredOf(InventoryController.prototype, 'stock')).toEqual(['inventory.view']);
    expect(requiredOf(InventoryController.prototype, 'movements')).toEqual(['inventory.view']);
    expect(requiredOf(InventoryController.prototype, 'locations')).toEqual(['inventory.view']);
    expect(requiredOf(InventoryController.prototype, 'transfer')).toEqual(['inventory.edit']);
    expect(requiredOf(InventoryController.prototype, 'listWarehouses')).toEqual(['inventory.view']);
    expect(requiredOf(InventoryController.prototype, 'createWarehouse')).toEqual(['inventory.warehouses.manage']);
    expect(requiredOf(InventoryController.prototype, 'updateWarehouse')).toEqual(['inventory.warehouses.manage']);
    expect(requiredOf(InventoryController.prototype, 'setDefaultWarehouse')).toEqual(['inventory.warehouses.manage']);
    expect(requiredOf(InventoryController.prototype, 'deleteWarehouse')).toEqual(['inventory.warehouses.manage']);

    // Goods receipts (Integrity Gate #9)
    expect(requiredOf(GoodsReceiptController.prototype, 'list')).toEqual(['goods_receipt.view']);
    expect(requiredOf(GoodsReceiptController.prototype, 'getById')).toEqual(['goods_receipt.view']);
    expect(requiredOf(GoodsReceiptController.prototype, 'listRelations')).toEqual(['goods_receipt.view']);
    expect(requiredOf(GoodsReceiptController.prototype, 'create')).toEqual(['goods_receipt.create']);
    expect(requiredOf(GoodsReceiptController.prototype, 'confirm')).toEqual(['goods_receipt.confirm']);
    expect(requiredOf(GoodsReceiptController.prototype, 'reverse')).toEqual(['goods_receipt.reverse']);
    expect(requiredOf(GoodsReceiptController.prototype, 'cancel')).toEqual(['goods_receipt.edit']);

    // Approvals + purchase receive
    expect(requiredOf(ApprovalsController.prototype, 'list')).toEqual(['approvals.decide']);
    expect(requiredOf(ApprovalsController.prototype, 'getById')).toEqual(['approvals.decide']);
    expect(requiredOf(ApprovalsController.prototype, 'decide')).toEqual(['approvals.decide']);
    expect(requiredOf(PurchaseController.prototype, 'receive')).toEqual(['purchase.edit']);
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
