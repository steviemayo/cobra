-- AlterTable
ALTER TABLE "OrgBilling" ADD COLUMN "billingInterval" TEXT NOT NULL DEFAULT 'month',
ADD COLUMN "anchorFirstOfMonth" BOOLEAN NOT NULL DEFAULT false;
