-- Portal-driven gateway updates: a per-gateway policy and the request in hand.
ALTER TABLE "Gateway" ADD COLUMN "autoUpdate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Gateway" ADD COLUMN "updateNotBefore" TIMESTAMP(3);
ALTER TABLE "Gateway" ADD COLUMN "updateVersion" TEXT;
ALTER TABLE "Gateway" ADD COLUMN "updateState" TEXT;
ALTER TABLE "Gateway" ADD COLUMN "updateError" TEXT;
ALTER TABLE "Gateway" ADD COLUMN "updateReportedAt" TIMESTAMP(3);
