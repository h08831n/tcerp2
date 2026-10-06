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
import { UsersService } from './users.service';
import {
  CreateUserDto,
  ResetPasswordDto,
  SetUserCompanyRolesDto,
  UpdateUserDto,
  UserQueryDto,
} from './users.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('users.view')
  list(@Query() query: UserQueryDto) {
    return this.usersService.list(query);
  }

  @Post()
  @RequirePermissions('users.create')
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.usersService.create(dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('users.view')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('users.edit')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.usersService.update(id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.usersService.remove(id, actor, this.ctx(request));
  }

  @Post(':id/password')
  @RequirePermissions('users.reset_password')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.usersService.resetPassword(id, dto, actor, this.ctx(request));
  }

  @Put(':id/companies/:companyId/roles')
  @RequirePermissions('users.edit')
  setCompanyRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: SetUserCompanyRolesDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.usersService.setCompanyRoles(id, companyId, dto, actor, this.ctx(request));
  }
}
