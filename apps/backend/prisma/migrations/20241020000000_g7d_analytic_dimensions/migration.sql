-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AnalyticDimensionType" ADD VALUE 'SALESPERSON';
ALTER TYPE "AnalyticDimensionType" ADD VALUE 'PRODUCT_VARIANT';

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "chart_of_accounts" DROP COLUMN "normal_side";

