-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "branding" JSONB;

-- CreateTable
CREATE TABLE "OrgBilling" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "status" TEXT NOT NULL DEFAULT 'none',
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlSession" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "snapshot" JSONB,
    "snapshotAt" TIMESTAMP(3),

    CONSTRAINT "ControlSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlIntent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "intent" JSONB NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "ControlIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgBilling_orgId_key" ON "OrgBilling"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgBilling_stripeCustomerId_key" ON "OrgBilling"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgBilling_stripeSubscriptionId_key" ON "OrgBilling"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "ControlSession_roomId_key" ON "ControlSession"("roomId");

-- CreateIndex
CREATE INDEX "ControlIntent_gatewayId_deliveredAt_idx" ON "ControlIntent"("gatewayId", "deliveredAt");

-- CreateIndex
CREATE INDEX "ControlIntent_roomId_createdAt_idx" ON "ControlIntent"("roomId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrgBilling" ADD CONSTRAINT "OrgBilling_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlSession" ADD CONSTRAINT "ControlSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlIntent" ADD CONSTRAINT "ControlIntent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Organisations that already exist start a fresh 30-day trial today.
INSERT INTO "OrgBilling" ("id", "orgId", "plan", "status", "trialEndsAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'trial', 'none', now() + interval '30 days', now() FROM "Org";
