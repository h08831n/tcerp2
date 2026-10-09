import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

type Client = Prisma.TransactionClient;

export interface StockMovementInsert {
  companyId: string;
  warehouseId: string;
  productVariantId: string;
  direction: 'IN' | 'OUT';
  quantity: Prisma.Decimal | number | string;
  uomId: string;
  movementDate: Date;
  sourceEntityType: string;
  sourceEntityId: string;
  idempotencyKey: string;
  createdBy?: string | null;
}

/**
 * Race-safe idempotent StockMovement insert (domain boundaries §4): the
 * unique `idempotency_key` is the ONLY duplicate authority, so the insert
 * uses `ON CONFLICT … DO NOTHING` instead of a create + P2002 catch — a
 * unique violation inside a transaction would POISON it (Postgres 25P02:
 * "current transaction is aborted"), breaking every later statement of the
 * same transaction (e.g. re-receive / forced re-run with more than one
 * movement). Returns true when a row was actually inserted.
 */
export async function insertStockMovementIfAbsent(
  tx: Client,
  data: StockMovementInsert,
): Promise<boolean> {
  const inserted = await tx.$executeRaw`
    INSERT INTO stock_movements
      (id, company_id, warehouse_id, product_variant_id, direction, quantity, uom_id,
       movement_date, source_entity_type, source_entity_id, idempotency_key, created_by)
    VALUES
      (${randomUUID()}::uuid, ${data.companyId}::uuid, ${data.warehouseId}::uuid,
       ${data.productVariantId}::uuid, ${data.direction}::"StockDirection", ${data.quantity},
       ${data.uomId}::uuid, ${data.movementDate}, ${data.sourceEntityType},
       ${data.sourceEntityId}::uuid, ${data.idempotencyKey}, ${data.createdBy ?? null}::uuid)
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
  return inserted === 1;
}
