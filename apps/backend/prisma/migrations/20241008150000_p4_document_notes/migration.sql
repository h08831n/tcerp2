-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex
DROP INDEX "purchase_lines_purchase_document_id_line_order_idx";

-- DropIndex
DROP INDEX "sales_lines_sales_document_id_line_order_idx";

-- AlterTable
ALTER TABLE "purchase_documents" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "sales_documents" ADD COLUMN     "notes" TEXT;

