-- CreateTable
CREATE TABLE "sales_reconcile_runs" (
    "id" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "trigger" VARCHAR(10) NOT NULL,
    "actorId" UUID,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "mismatchCount" INTEGER NOT NULL DEFAULT 0,
    "mismatches" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,

    CONSTRAINT "sales_reconcile_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_reconcile_runs_startedAt_idx" ON "sales_reconcile_runs"("startedAt" DESC);
