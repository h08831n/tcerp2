-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('STORABLE', 'CONSUMABLE', 'SERVICE');

-- DropIndex
DROP INDEX "parties_name_fa_trgm_idx";

-- AlterTable
ALTER TABLE "supplier_products" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "supplier_product_name" TEXT;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "parent_id" UUID,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "code" TEXT NOT NULL,
    "logo_attachment_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uom_categories" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uom_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uoms" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "symbol" TEXT NOT NULL,
    "conversion_ratio" DECIMAL(20,6) NOT NULL,
    "is_base_unit" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_values" (
    "id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "value_fa" TEXT NOT NULL,
    "value_en" TEXT,
    "code" TEXT NOT NULL,
    "numeric_value" DECIMAL(20,6),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "brand_id" UUID,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "internal_code" TEXT,
    "description" TEXT,
    "product_type" "ProductType" NOT NULL DEFAULT 'STORABLE',
    "is_sellable" BOOLEAN NOT NULL DEFAULT true,
    "is_purchasable" BOOLEAN NOT NULL DEFAULT true,
    "default_sales_uom_id" UUID,
    "default_purchase_uom_id" UUID,
    "default_sales_price" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "default_tax_definition_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "product_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_template_attributes" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "creates_variants" BOOLEAN NOT NULL DEFAULT true,
    "is_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_template_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "weight_per_unit" DECIMAL(18,4),
    "default_uom_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_attribute_values" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "attribute_value_id" UUID NOT NULL,

    CONSTRAINT "variant_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_company_id_parent_id_idx" ON "product_categories"("company_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_company_id_code_key" ON "product_categories"("company_id", "code");

-- CreateIndex
CREATE INDEX "brands_company_id_name_fa_idx" ON "brands"("company_id", "name_fa");

-- CreateIndex
CREATE UNIQUE INDEX "brands_company_id_code_key" ON "brands"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uom_categories_company_id_code_key" ON "uom_categories"("company_id", "code");

-- CreateIndex
CREATE INDEX "uoms_company_id_category_id_idx" ON "uoms"("company_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "uoms_company_id_symbol_key" ON "uoms"("company_id", "symbol");

-- CreateIndex
CREATE INDEX "attributes_company_id_active_idx" ON "attributes"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "attributes_company_id_code_key" ON "attributes"("company_id", "code");

-- CreateIndex
CREATE INDEX "attribute_values_attribute_id_active_idx" ON "attribute_values"("attribute_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_values_attribute_id_code_key" ON "attribute_values"("attribute_id", "code");

-- CreateIndex
CREATE INDEX "product_templates_company_id_name_fa_idx" ON "product_templates"("company_id", "name_fa");

-- CreateIndex
CREATE INDEX "product_templates_company_id_active_idx" ON "product_templates"("company_id", "active");

-- CreateIndex
CREATE INDEX "product_templates_company_id_category_id_idx" ON "product_templates"("company_id", "category_id");

-- CreateIndex
CREATE INDEX "product_templates_company_id_brand_id_idx" ON "product_templates"("company_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_templates_company_id_internal_code_key" ON "product_templates"("company_id", "internal_code");

-- CreateIndex
CREATE INDEX "product_template_attributes_template_id_display_order_idx" ON "product_template_attributes"("template_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_template_attributes_template_id_attribute_id_key" ON "product_template_attributes"("template_id", "attribute_id");

-- CreateIndex
CREATE INDEX "product_variants_template_id_active_idx" ON "product_variants"("template_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_company_id_sku_key" ON "product_variants"("company_id", "sku");

-- CreateIndex
CREATE INDEX "variant_attribute_values_attribute_value_id_idx" ON "variant_attribute_values"("attribute_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_attribute_values_variant_id_attribute_id_key" ON "variant_attribute_values"("variant_id", "attribute_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_attribute_values_variant_id_attribute_value_id_key" ON "variant_attribute_values"("variant_id", "attribute_value_id");

-- CreateIndex
CREATE INDEX "supplier_products_product_variant_id_idx" ON "supplier_products"("product_variant_id");

-- CreateIndex
CREATE INDEX "supplier_products_product_template_id_idx" ON "supplier_products"("product_template_id");

-- CreateIndex
CREATE INDEX "supplier_products_category_id_idx" ON "supplier_products"("category_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_logo_attachment_id_fkey" FOREIGN KEY ("logo_attachment_id") REFERENCES "file_attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom_categories" ADD CONSTRAINT "uom_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "uom_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributes" ADD CONSTRAINT "attributes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_default_sales_uom_id_fkey" FOREIGN KEY ("default_sales_uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_default_purchase_uom_id_fkey" FOREIGN KEY ("default_purchase_uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_default_tax_definition_id_fkey" FOREIGN KEY ("default_tax_definition_id") REFERENCES "tax_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_template_attributes" ADD CONSTRAINT "product_template_attributes_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "product_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_template_attributes" ADD CONSTRAINT "product_template_attributes_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "product_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_default_uom_id_fkey" FOREIGN KEY ("default_uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_value_id_fkey" FOREIGN KEY ("attribute_value_id") REFERENCES "attribute_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_party_id_fkey" FOREIGN KEY ("supplier_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_template_id_fkey" FOREIGN KEY ("product_template_id") REFERENCES "product_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Phase 3B: Persian fuzzy product-name search
CREATE INDEX "product_templates_name_fa_trgm_idx" ON "product_templates" USING gin ("name_fa" gin_trgm_ops);
CREATE INDEX "brands_name_fa_trgm_idx" ON "brands" USING gin ("name_fa" gin_trgm_ops);
-- Base-unit integrity: exactly one base unit per UOM category
CREATE UNIQUE INDEX "uoms_base_unit_uniq" ON "uoms" ("category_id") WHERE "is_base_unit" = true;
