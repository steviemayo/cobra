-- AlterTable
ALTER TABLE "DeviceStatus" ADD COLUMN "driver" TEXT,
ADD COLUMN "firmware" TEXT,
ADD COLUMN "firmwareSince" TIMESTAMP(3);
