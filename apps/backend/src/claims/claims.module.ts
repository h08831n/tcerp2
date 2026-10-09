import { Module } from '@nestjs/common';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { PartyOperationalBalanceService } from './party-balance.service';
import { PartyOperationalBalanceController } from './party-balance.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ClaimsController, PartyOperationalBalanceController],
  providers: [ClaimsService, PartyOperationalBalanceService],
  exports: [ClaimsService, PartyOperationalBalanceService],
})
export class ClaimsModule {}
