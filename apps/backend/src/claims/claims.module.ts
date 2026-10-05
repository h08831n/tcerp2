import { Module } from '@nestjs/common';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { PartyOperationalBalanceService } from './party-balance.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ClaimsController],
  providers: [ClaimsService, PartyOperationalBalanceService],
  exports: [ClaimsService, PartyOperationalBalanceService],
})
export class ClaimsModule {}
