-- AlterTable
ALTER TABLE "PmSchedule" ADD COLUMN     "areaId" UUID,
ADD COLUMN     "roomIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'room',
ADD COLUMN     "siteId" UUID;

-- AlterTable
ALTER TABLE "PmRun" ADD COLUMN     "multi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentRunId" UUID,
ADD COLUMN     "scopeLabel" TEXT,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "skipReason" TEXT,
ADD COLUMN     "workedBy" UUID,
ADD COLUMN     "workedByName" TEXT;

-- CreateIndex
CREATE INDEX "PmRun_parentRunId_idx" ON "PmRun"("parentRunId");
