import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * GET /api/permissions — the permission catalog (grouped by module on the
 * client; role editors need `roles.view` to read it).
 */
@Controller('permissions')
export class PermissionsCatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('roles.view')
  async catalog() {
    const [permissions, total] = await Promise.all([
      this.prisma.permission.findMany({
        orderBy: [{ module: 'asc' }, { action: 'asc' }],
      }),
      this.prisma.permission.count(),
    ]);
    return { items: permissions, total };
  }
}
