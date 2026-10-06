import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CategoriesService } from './categories.service';
import { BrandsService } from './brands.service';
import { UomsService } from './uoms.service';
import { UomConversionService } from './uom-conversion.service';
import { AttributesService } from './attributes.service';
import { TemplatesService } from './templates.service';
import { SupplierMappingsService } from './supplier-mappings.service';
import { CategoriesController, BrandsController } from './catalog.controller';
import { UomsController, UomConversionController } from './uoms.controller';
import { AttributesController, AttributeValuesController } from './attributes.controller';
import { TemplatesController } from './templates.controller';
import { SupplierMappingsController } from './supplier-mappings.controller';

/**
 * Phase 3B — Product Catalog: hierarchical categories, brands, the UOM
 * engine (Decimal conversions, one base unit per category), dynamic
 * attributes, Odoo-style ProductTemplate/ProductVariant with generated
 * variant combinations, and three-level supplier mappings.
 */
@Module({
  imports: [AuditModule],
  controllers: [
    CategoriesController,
    BrandsController,
    UomsController,
    UomConversionController,
    AttributesController,
    AttributeValuesController,
    TemplatesController,
    SupplierMappingsController,
  ],
  providers: [
    CategoriesService,
    BrandsService,
    UomsService,
    UomConversionService,
    AttributesService,
    TemplatesService,
    SupplierMappingsService,
  ],
  exports: [UomConversionService],
})
export class ProductsModule {}
