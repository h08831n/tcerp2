import { Injectable, Logger } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto } from './audit.dto';
import { Paginated } from '../common/dto/pagination.dto';

export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  actor?: { id?: string; username?: string };
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Central audit trail (REQUIREMENTS §2.1, §110). Never throws to the caller —
 * an audit write failure must not break the business operation; it is logged
 * for observability instead.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          actorId: entry.actor?.id ?? null,
          actorName: entry.actor?.username ?? null,
          oldValues: toJson(entry.oldValues),
          newValues: toJson(entry.newValues),
          reason: entry.reason ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record audit entry ${entry.entityType}/${entry.entityId} action=${entry.action}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async list(query: AuditQueryDto): Promise<Paginated<AuditLog>> {
    const where: Prisma.AuditLogWhereInput = {
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
      action: query.action,
    };

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
