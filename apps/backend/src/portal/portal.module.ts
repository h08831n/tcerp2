import { Module } from '@nestjs/common';
import { PortalAccountsController } from './portal.controller';
import { PortalAccountService } from './portal.service';
import { PortalAuthController } from './portal-auth.controller';
import { PortalBusinessController } from './portal-business.controller';
import { PortalOtpService } from './portal-auth.service';
import { PortalBusinessService } from './portal-business.service';
import { PortalAuthGuard } from './portal-auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PortalAccountsController, PortalAuthController, PortalBusinessController],
  providers: [PortalAccountService, PortalOtpService, PortalBusinessService, PortalAuthGuard],
  exports: [PortalAccountService, PortalOtpService, PortalBusinessService],
})
export class PortalModule {}
