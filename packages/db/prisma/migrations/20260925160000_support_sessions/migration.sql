-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "staffAccessBlocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportSession_orgId_startedAt_idx" ON "SupportSession"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportSession_staffUserId_endsAt_idx" ON "SupportSession"("staffUserId", "endsAt");

