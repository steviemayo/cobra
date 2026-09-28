-- Gateways that are running but have no definition in any organisation, announced for staff to claim.
CREATE TABLE "UnclaimedGateway" (
    "id" UUID NOT NULL,
    "installId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "hostname" TEXT,
    "os" TEXT,
    "version" TEXT,
    "localAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publicIp" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedGatewayId" UUID,
    "claimedBy" UUID,
    "claimedAt" TIMESTAMP(3),
    "claimTokenSealed" TEXT,

    CONSTRAINT "UnclaimedGateway_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnclaimedGateway_installId_key" ON "UnclaimedGateway"("installId");
CREATE INDEX "UnclaimedGateway_status_lastSeenAt_idx" ON "UnclaimedGateway"("status", "lastSeenAt");
CREATE INDEX "UnclaimedGateway_publicIp_firstSeenAt_idx" ON "UnclaimedGateway"("publicIp", "firstSeenAt");
