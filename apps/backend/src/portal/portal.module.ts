import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { PortalAccountsController } from './portal.controller';
import { PortalAccountService } from './portal.service';
import { PortalAuthController } from './portal-auth.controller';
import { PortalBusinessController } from './portal-business.controller';
import { PortalFilesController } from './portal-files.controller';
import { PortalOtpService } from './portal-auth.service';
import { PortalBusinessService } from './portal-business.service';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalFetchMetadataMiddleware } from './portal-fetch-metadata.middleware';
import { NotificationsModule } from '../notifications/notifications.module';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [NotificationsModule, FilesModule],
  controllers: [PortalAccountsController, PortalAuthController, PortalBusinessController, PortalFilesController],
  providers: [PortalAccountService, PortalOtpService, PortalBusinessService, PortalAuthGuard],
  exports: [PortalAccountService, PortalOtpService, PortalBusinessService],
})
export class PortalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // D2-13: Fetch Metadata defense for every /api/portal route.
    consumer.apply(PortalFetchMetadataMiddleware).forRoutes('portal');
  }
}
