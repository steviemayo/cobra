-- AlterTable
ALTER TABLE "OrgBilling" ADD COLUMN     "billedBy" TEXT NOT NULL DEFAULT 'self',
ADD COLUMN     "delegationDeclineReason" TEXT,
ADD COLUMN     "delegationDecidedAt" TIMESTAMP(3),
ADD COLUMN     "delegationDecidedBy" UUID,
ADD COLUMN     "delegationEndsAt" TIMESTAMP(3),
ADD COLUMN     "delegationHandoverAt" TIMESTAMP(3),
ADD COLUMN     "delegationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "delegationRequestedBy" UUID,
ADD COLUMN     "delegationStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "payerOrgId" UUID,
ADD COLUMN     "providerDiscountCouponId" TEXT,
ADD COLUMN     "providerDiscountPercent" INTEGER;

-- CreateIndex
CREATE INDEX "OrgBilling_payerOrgId_delegationStatus_idx" ON "OrgBilling"("payerOrgId", "delegationStatus");
