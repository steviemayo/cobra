-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "configParams" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "configState" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "profileId" UUID;

-- CreateTable
CREATE TABLE "ConfigProfile" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "params" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSnapshot" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "data" JSONB NOT NULL,
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "takenBy" UUID,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigDeploy" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "profileName" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "deviceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "canaryIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "stage" TEXT NOT NULL DEFAULT 'done',
    "snapshots" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigDeploy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConfigProfile_orgId_idx" ON "ConfigProfile"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigProfile_orgId_name_key" ON "ConfigProfile"("orgId", "name");

-- CreateIndex
CREATE INDEX "DeviceSnapshot_deviceId_takenAt_idx" ON "DeviceSnapshot"("deviceId", "takenAt");

-- CreateIndex
CREATE INDEX "DeviceSnapshot_orgId_idx" ON "DeviceSnapshot"("orgId");

-- CreateIndex
CREATE INDEX "ConfigDeploy_orgId_createdAt_idx" ON "ConfigDeploy"("orgId", "createdAt");
