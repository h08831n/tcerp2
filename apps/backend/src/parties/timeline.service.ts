import { Injectable } from '@nestjs/common';
import { Prisma, TimelineEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Client = PrismaService | Prisma.TransactionClient;

export interface TimelineInput {
  companyId: string;
  entityType: string;
  entityId: string;
  type: string;
  title: string;
  description?: string;
  data?: unknown;
  actorType?: 'USER' | 'SYSTEM';
  actorUserId?: string | null;
  /** Noise control (REQUIREMENTS §60): routine events can be hidden. */
  visible?: boolean;
}

/**
 * Normalize a value for JSON storage + comparison: undefined → null,
 * Date → ISO string, Decimal/bigint → string (Decimal.toJSON is a string).
 */
export function normalizeTimelineValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object' && 'toJSON' in (value as object)) {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  return value;
}

/**
 * Field-level diff for update timeline events: `{ field: { old, new } }` for
 * every field whose value actually differs from the stored row. Keys whose
 * patch value is `undefined` mean "not provided" (Prisma PATCH semantics) and
 * are skipped; an explicit `null` IS a change. `version` is never diffed
 * (optimistic-concurrency bookkeeping).
 */
export function buildChanges(
  oldRow: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(patch)) {
    if (key === 'version' || patch[key] === undefined) continue;
    const oldValue = normalizeTimelineValue(oldRow[key]);
    const newValue = normalizeTimelineValue(patch[key]);
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = { old: oldValue, new: newValue };
    }
  }
  return changes;
}

/**
 * Generic timeline foundation (Phase 3A: PARTY entities). Append-only,
 * company-scoped, written inside the same transaction as the mutation
 * whenever the caller has one.
 */
@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async record(client: Client, input: TimelineInput): Promise<TimelineEvent> {
    const db = (client ?? this.prisma) as Client;
    return db.timelineEvent.create({
      data: {
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        type: input.type,
        title: input.title,
        description: input.description,
        data: (input.data === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(input.data)) as Prisma.InputJsonValue)) as Prisma.InputJsonValue,
        actorType: input.actorType ?? 'USER',
        actorUserId: input.actorUserId ?? null,
        visible: input.visible ?? true,
      },
    });
  }

  /**
   * Timeline rows for an entity, newest first. `includeHidden` is granted by
   * the controller only when the caller may see hidden events (scope ALL or
   * audit.view) and explicitly asked for them.
   */
  async listForEntity(
    companyId: string,
    entityType: string,
    entityId: string,
    options: { limit?: number; includeHidden?: boolean } = {},
  ): Promise<TimelineEvent[]> {
    return this.prisma.timelineEvent.findMany({
      where: {
        companyId,
        entityType,
        entityId,
        ...(options.includeHidden ? {} : { visible: true }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }
}
