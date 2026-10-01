-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "roomIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "DeviceRoom" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceRoom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceRoom_orgId_idx" ON "DeviceRoom"("orgId");

-- CreateIndex
CREATE INDEX "DeviceRoom_roomId_idx" ON "DeviceRoom"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRoom_deviceId_roomId_key" ON "DeviceRoom"("deviceId", "roomId");

-- AddForeignKey
ALTER TABLE "DeviceRoom" ADD CONSTRAINT "DeviceRoom_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRoom" ADD CONSTRAINT "DeviceRoom_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRoom" ADD CONSTRAINT "DeviceRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

