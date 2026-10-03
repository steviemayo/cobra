-- CreateTable
CREATE TABLE "BriefingSubscription" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "siteId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BriefingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BriefingSubscription_userId_channelId_siteId_key" ON "BriefingSubscription"("userId", "channelId", "siteId");

-- CreateIndex
CREATE INDEX "BriefingSubscription_orgId_idx" ON "BriefingSubscription"("orgId");

-- AddForeignKey
ALTER TABLE "BriefingSubscription" ADD CONSTRAINT "BriefingSubscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefingSubscription" ADD CONSTRAINT "BriefingSubscription_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
