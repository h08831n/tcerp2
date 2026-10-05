import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Global Prisma client. Connects on module init; the app registers shutdown
 * hooks (main.ts `enableShutdownHooks`) so `onModuleDestroy` runs on
 * SIGTERM/SIGINT for a graceful disconnect.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
