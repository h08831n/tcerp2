-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "combination_key" TEXT,
ADD COLUMN     "weight_uom_id" UUID;

-- CreateTable
CREATE TABLE "product_template_attribute_values" (
    "id" UUID NOT NULL,
    "template_attribute_id" UUID NOT NULL,
    "attribute_value_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_template_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_template_attribute_values_template_attribute_id_dis_idx" ON "product_template_attribute_values"("template_attribute_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_template_attribute_values_template_attribute_id_att_key" ON "product_template_attribute_values"("template_attribute_id", "attribute_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_template_id_combination_key_key" ON "product_variants"("template_id", "combination_key");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_weight_uom_id_fkey" FOREIGN KEY ("weight_uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_template_attribute_values" ADD CONSTRAINT "product_template_attribute_values_template_attribute_id_fkey" FOREIGN KEY ("template_attribute_id") REFERENCES "product_template_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_template_attribute_values" ADD CONSTRAINT "product_template_attribute_values_attribute_value_id_fkey" FOREIGN KEY ("attribute_value_id") REFERENCES "attribute_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 3B corrections: restore the CRM trgm index dropped by the diff-based 3B
-- migration (regression reported in review) + search-support index.
CREATE INDEX IF NOT EXISTS "parties_name_fa_trgm_idx" ON "parties" USING gin ("name_fa" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "contact_phones_normalized_value_idx" ON "contact_phones" ("normalized_value");

-- Backfill canonical combination keys from existing variant values
-- (sorted attribute_id=attribute_value_id pairs, '|' separated).
UPDATE product_variants pv
SET combination_key = k.key
FROM (
  SELECT v.id,
         string_agg(vav.attribute_id::text || '=' || vav.attribute_value_id::text, '|' ORDER BY vav.attribute_id::text, vav.attribute_value_id::text) AS key
  FROM product_variants v
  JOIN variant_attribute_values vav ON vav.variant_id = v.id
  GROUP BY v.id
) k
WHERE pv.id = k.id AND pv.combination_key IS NULL;
-- Degenerate value-less variants get a random key (documented; none expected in dev data)
UPDATE product_variants SET combination_key = gen_random_uuid()::text WHERE combination_key IS NULL;

ALTER TABLE "product_variants" ALTER COLUMN "combination_key" SET NOT NULL;

-- UOM integrity CHECKs (correction #6): ratio > 0; base unit ratio must be 1.
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_conversion_ratio_positive_chk" CHECK ("conversion_ratio" > 0);
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_base_ratio_one_chk" CHECK ("is_base_unit" = false OR "conversion_ratio" = 1);
