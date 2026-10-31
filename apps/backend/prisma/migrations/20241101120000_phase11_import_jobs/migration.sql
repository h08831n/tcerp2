-- Phase 11 (Gate G): durable resumable CSV import jobs. Forward-only.
CREATE TYPE "ImportEntityType" AS ENUM ('PARTY');
CREATE TYPE "ImportJobStatus" AS ENUM ('VALIDATED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'OK', 'FAILED', 'DUPLICATE');

CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "entityType" "ImportEntityType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'VALIDATED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "ok_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "commitMode" TEXT NOT NULL DEFAULT 'PER_ROW',
    "batch_size" INTEGER NOT NULL DEFAULT 500,
    "options" JSONB,
    "column_mapping" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_jobs_company_id_created_at_idx" ON "import_jobs"("company_id", "created_at");
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "import_job_rows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_index" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "import_job_rows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "import_job_rows_job_id_row_index_key" ON "import_job_rows"("job_id", "row_index");
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
