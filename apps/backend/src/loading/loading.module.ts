import { Module } from '@nestjs/common';
import { LoadingController } from './loading.controller';
import { LoadingService } from './loading.service';

@Module({
  controllers: [LoadingController],
  providers: [LoadingService],
  exports: [LoadingService],
})
export class LoadingModule {}
