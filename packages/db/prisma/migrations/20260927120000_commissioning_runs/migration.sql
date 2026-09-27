-- CreateTable
CREATE TABLE "CommissioningRun" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "releaseNumber" INTEGER,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "startedBy" UUID,
    "startedByEmail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedOffBy" UUID,
    "signedOffByEmail" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "notes" TEXT,
    CONSTRAINT "CommissioningRun_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "CommissioningRun_roomId_startedAt_idx" ON "CommissioningRun"("roomId", "startedAt");
-- CreateIndex
CREATE INDEX "CommissioningRun_orgId_idx" ON "CommissioningRun"("orgId");
-- AddForeignKey
ALTER TABLE "CommissioningRun" ADD CONSTRAINT "CommissioningRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CommissioningRun" ADD CONSTRAINT "CommissioningRun_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
