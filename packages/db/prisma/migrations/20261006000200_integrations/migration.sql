-- Integrations: cloud sources of device state (Zoom, Reflect, Teams, Sync, Webex, XiO).
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "siteIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "defaultSiteId" UUID,
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "sealed" TEXT NOT NULL,
    "inboundHash" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Integration_orgId_name_key" ON "Integration"("orgId", "name");
CREATE INDEX "Integration_orgId_idx" ON "Integration"("orgId");

ALTER TABLE "Integration" ADD CONSTRAINT "Integration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Device" ADD COLUMN "integrationId" UUID,
ADD COLUMN "externalId" TEXT;

CREATE UNIQUE INDEX "Device_integrationId_externalId_key" ON "Device"("integrationId", "externalId");

ALTER TABLE "Device" ADD CONSTRAINT "Device_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
