import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { RolesService } from './roles.service';
import { CreateRoleDto, RoleQueryDto, SetRolePermissionsDto, UpdateRoleDto } from './roles.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('roles.view')
  list(@Query() query: RoleQueryDto) {
    return this.rolesService.list(query);
  }

  @Post()
  @RequirePermissions('roles.create')
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.rolesService.create(dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('roles.view')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('roles.edit')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.rolesService.update(id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('roles.delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.rolesService.remove(id, actor, this.ctx(request));
  }

  @Put(':id/permissions')
  @RequirePermissions('roles.edit')
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.rolesService.setPermissions(id, dto, actor, this.ctx(request));
  }
}
