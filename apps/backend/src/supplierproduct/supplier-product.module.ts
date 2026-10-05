import { Module } from '@nestjs/common';
import { SupplierProductController } from './supplier-product.controller';
import { SupplierProductService } from './supplier-product.service';

@Module({
  controllers: [SupplierProductController],
  providers: [SupplierProductService],
  exports: [SupplierProductService],
})
export class SupplierProductModule {}
