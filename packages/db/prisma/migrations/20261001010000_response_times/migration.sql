-- Ping round-trip times per device (5-minute buckets and an hourly rollup) and per-organisation limits.
CREATE TABLE "LatencyBucket" (
    "deviceId" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "sent" INTEGER NOT NULL,
    "ok" INTEGER NOT NULL,
    "sumMs" DOUBLE PRECISION NOT NULL,
    "minMs" DOUBLE PRECISION,
    "maxMs" DOUBLE PRECISION,

    CONSTRAINT "LatencyBucket_pkey" PRIMARY KEY ("deviceId","bucket")
);

CREATE TABLE "LatencyHour" (
    "deviceId" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "sent" INTEGER NOT NULL,
    "ok" INTEGER NOT NULL,
    "sumMs" DOUBLE PRECISION NOT NULL,
    "minMs" DOUBLE PRECISION,
    "maxMs" DOUBLE PRECISION,

    CONSTRAINT "LatencyHour_pkey" PRIMARY KEY ("deviceId","bucket")
);

CREATE TABLE "OrgLatencySettings" (
    "orgId" UUID NOT NULL,
    "factor" DOUBLE PRECISION,
    "minIncreaseMs" DOUBLE PRECISION,
    "highMs" DOUBLE PRECISION,
    "lossPercent" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgLatencySettings_pkey" PRIMARY KEY ("orgId")
);

CREATE INDEX "LatencyBucket_orgId_bucket_idx" ON "LatencyBucket"("orgId", "bucket");
CREATE INDEX "LatencyBucket_siteId_bucket_idx" ON "LatencyBucket"("siteId", "bucket");
CREATE INDEX "LatencyHour_orgId_bucket_idx" ON "LatencyHour"("orgId", "bucket");
CREATE INDEX "LatencyHour_siteId_bucket_idx" ON "LatencyHour"("siteId", "bucket");

ALTER TABLE "LatencyBucket" ADD CONSTRAINT "LatencyBucket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LatencyHour" ADD CONSTRAINT "LatencyHour_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgLatencySettings" ADD CONSTRAINT "OrgLatencySettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
