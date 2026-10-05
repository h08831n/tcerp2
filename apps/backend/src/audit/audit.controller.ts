import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './audit.dto';
import { Paginated } from '../common/dto/pagination.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuditLog } from '@prisma/client';

@Controller('audit')
@RequirePermissions('audit.view')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(@Query() query: AuditQueryDto): Promise<Paginated<AuditLog>> {
    return this.auditService.list(query);
  }
}
