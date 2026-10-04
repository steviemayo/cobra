-- AlterTable
ALTER TABLE "PmRun" ADD COLUMN     "correctionReason" TEXT,
ADD COLUMN     "correctsRunId" UUID;

-- CreateTable
CREATE TABLE "PmPhoto" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "itemId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PmPhoto_runId_idx" ON "PmPhoto"("runId");

-- CreateIndex
CREATE INDEX "PmPhoto_orgId_idx" ON "PmPhoto"("orgId");

-- CreateIndex
CREATE INDEX "PmRun_correctsRunId_idx" ON "PmRun"("correctsRunId");
