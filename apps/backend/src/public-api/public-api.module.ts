import { Module } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';

/** Public (unauthenticated) website/portal API — see PublicApiService. */
@Module({
  controllers: [PublicApiController],
  providers: [PublicApiService],
})
export class PublicApiModule {}
