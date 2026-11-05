import { Module } from '@nestjs/common';
import { PortalAccountsController } from './portal.controller';
import { PortalAccountService } from './portal.service';
import { PortalAuthController } from './portal-auth.controller';
import { PortalOtpService } from './portal-auth.service';
import { PortalAuthGuard } from './portal-auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PortalAccountsController, PortalAuthController],
  providers: [PortalAccountService, PortalOtpService, PortalAuthGuard],
  exports: [PortalAccountService, PortalOtpService],
})
export class PortalModule {}
