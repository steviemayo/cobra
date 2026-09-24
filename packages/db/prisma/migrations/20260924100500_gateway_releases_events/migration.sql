-- AlterTable
ALTER TABLE "Gateway" ADD COLUMN     "credentialHash" TEXT,
ADD COLUMN     "enrollTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "enrolledAt" TIMESTAMP(3),
ADD COLUMN     "hostname" TEXT,
ADD COLUMN     "os" TEXT,
ADD COLUMN     "version" TEXT;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "desiredReleaseId" UUID,
ADD COLUMN     "panel" JSONB,
ADD COLUMN     "reportedAt" TIMESTAMP(3),
ADD COLUMN     "reportedError" TEXT,
ADD COLUMN     "reportedReleaseId" UUID,
ADD COLUMN     "reportedStatus" TEXT;

-- CreateTable
CREATE TABLE "Release" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "roomId" UUID,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Release_orgId_idx" ON "Release"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Release_roomId_number_key" ON "Release"("roomId", "number");

-- CreateIndex
CREATE INDEX "GatewayEvent_gatewayId_at_idx" ON "GatewayEvent"("gatewayId", "at");

-- CreateIndex
CREATE INDEX "GatewayEvent_orgId_at_idx" ON "GatewayEvent"("orgId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_credentialHash_key" ON "Gateway"("credentialHash");

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayEvent" ADD CONSTRAINT "GatewayEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayEvent" ADD CONSTRAINT "GatewayEvent_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

