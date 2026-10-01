-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "areaId" UUID,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Area" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "roomId" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'passive',
    "category" TEXT NOT NULL,
    "control" JSONB,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "values" JSONB NOT NULL DEFAULT '{}',
    "sealed" TEXT,
    "credentialSetId" UUID,
    "gatewayId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "make" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "mac" TEXT,
    "ip" TEXT,
    "firmware" TEXT,
    "assetTag" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_service',
    "installedOn" DATE,
    "warrantyEndsOn" DATE,
    "endOfLifeOn" DATE,
    "supplier" TEXT,
    "notes" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "retiredIdentities" JSONB NOT NULL DEFAULT '[]',
    "swapPending" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN,
    "since" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "feedback" JSONB,
    "details" JSONB,
    "firmwareSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "source" TEXT NOT NULL DEFAULT 'system',
    "actorId" UUID,
    "data" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Area_orgId_idx" ON "Area"("orgId");

-- CreateIndex
CREATE INDEX "Area_siteId_idx" ON "Area"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_siteId_parentId_name_key" ON "Area"("siteId", "parentId", "name");

-- CreateIndex
CREATE INDEX "Device_orgId_idx" ON "Device"("orgId");

-- CreateIndex
CREATE INDEX "Device_siteId_idx" ON "Device"("siteId");

-- CreateIndex
CREATE INDEX "Device_roomId_idx" ON "Device"("roomId");

-- CreateIndex
CREATE INDEX "Device_gatewayId_idx" ON "Device"("gatewayId");

-- CreateIndex
CREATE INDEX "DeviceEvent_orgId_idx" ON "DeviceEvent"("orgId");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_at_idx" ON "DeviceEvent"("deviceId", "at");

-- CreateIndex
CREATE INDEX "Room_areaId_idx" ON "Room"("areaId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
