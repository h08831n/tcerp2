import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto, UpdateCompanyDto } from './companies.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('companies.view')
  list() {
    return this.companiesService.list();
  }

  @Post()
  @RequirePermissions('companies.create')
  create(
    @Body() dto: CreateCompanyDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.companiesService.create(dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('companies.view')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.companiesService.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('companies.edit')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.companiesService.update(id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('companies.delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.companiesService.remove(id, actor, this.ctx(request));
  }
}
