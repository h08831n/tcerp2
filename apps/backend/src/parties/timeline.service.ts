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
