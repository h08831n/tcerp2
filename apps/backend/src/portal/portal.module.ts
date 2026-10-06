import { Module } from '@nestjs/common';
import { PortalAccountsController } from './portal.controller';
import { PortalAccountService } from './portal.service';

@Module({
  controllers: [PortalAccountsController],
  providers: [PortalAccountService],
  exports: [PortalAccountService],
})
export class PortalModule {}
