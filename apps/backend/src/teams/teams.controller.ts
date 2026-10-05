import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { TeamsService } from './teams.service';
import { CreateTeamDto, TeamQueryDto, UpdateTeamDto } from './teams.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('teams.view')
  list(@Query() query: TeamQueryDto) {
    return this.teamsService.list(query);
  }

  @Post()
  @RequirePermissions('teams.create')
  create(
    @Body() dto: CreateTeamDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.teamsService.create(dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('teams.view')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.teamsService.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('teams.edit')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.teamsService.update(id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('teams.delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.teamsService.remove(id, actor, this.ctx(request));
  }
}
