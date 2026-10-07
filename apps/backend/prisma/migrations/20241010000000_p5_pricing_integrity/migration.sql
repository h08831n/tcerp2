-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "purchase_lines" ADD COLUMN     "price_date" DATE,
ADD COLUMN     "price_source" TEXT;

-- AlterTable
ALTER TABLE "sales_lines" ADD COLUMN     "price_date" DATE,
ADD COLUMN     "price_source" TEXT;

