import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { Request } from 'express';
import { DocumentRelationService } from './document-relation.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * GET /api/documents/:type/:id/relations — the "Related Documents" panel
 * (REQUIREMENTS §13). Relation visibility follows the underlying documents'
 * own permissions (the endpoint is authenticated + company-scoped; each
 * caller already needs the respective module's view permission to act on the
 * linked documents).
 */
@Controller('documents')
export class DocumentRelationsController {
  constructor(
    private readonly relations: DocumentRelationService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get(':type/:id/relations')
  async list(
    @Param('type') type: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.relations.listRelations(companyId, type, id);
  }
}
