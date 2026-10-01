-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "defaultGatewayId" UUID;

-- CreateTable
CREATE TABLE "DeviceHistory" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "roomId" UUID,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageDefinition" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID,
    "kind" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "holdOffSeconds" INTEGER NOT NULL DEFAULT 180,
    "minOnSeconds" INTEGER NOT NULL DEFAULT 60,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSettings" (
    "orgId" UUID NOT NULL,
    "workDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "workStart" TEXT NOT NULL DEFAULT '08:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "RoomUsageDay" (
    "roomId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "orgId" UUID NOT NULL,
    "minutes" INTEGER NOT NULL,
    "workMinutes" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "longestMinutes" INTEGER NOT NULL,
    "hours" INTEGER[],

    CONSTRAINT "RoomUsageDay_pkey" PRIMARY KEY ("roomId","kind","day")
);

-- CreateIndex
CREATE INDEX "DeviceHistory_deviceId_field_at_idx" ON "DeviceHistory"("deviceId", "field", "at");

-- CreateIndex
CREATE INDEX "DeviceHistory_roomId_at_idx" ON "DeviceHistory"("roomId", "at");

-- CreateIndex
CREATE INDEX "DeviceHistory_orgId_at_idx" ON "DeviceHistory"("orgId", "at");

-- CreateIndex
CREATE INDEX "UsageDefinition_orgId_idx" ON "UsageDefinition"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDefinition_orgId_roomId_kind_key" ON "UsageDefinition"("orgId", "roomId", "kind");

-- CreateIndex
CREATE INDEX "RoomUsageDay_orgId_day_idx" ON "RoomUsageDay"("orgId", "day");
