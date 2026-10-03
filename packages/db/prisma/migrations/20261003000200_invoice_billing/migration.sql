-- AlterTable
ALTER TABLE "OrgBilling" ADD COLUMN     "collectionMethod" TEXT NOT NULL DEFAULT 'charge_automatically',
ADD COLUMN     "invoiceDeclineReason" TEXT,
ADD COLUMN     "invoiceDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "invoiceDecidedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceDecidedBy" UUID,
ADD COLUMN     "invoiceRequestNote" TEXT,
ADD COLUMN     "invoiceRequestedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "openInvoiceDueAt" TIMESTAMP(3),
ADD COLUMN     "openInvoiceId" TEXT,
ADD COLUMN     "openInvoiceUrl" TEXT;

-- CreateIndex
CREATE INDEX "OrgBilling_invoiceStatus_idx" ON "OrgBilling"("invoiceStatus");

-- CreateIndex
CREATE INDEX "OrgBilling_openInvoiceDueAt_idx" ON "OrgBilling"("openInvoiceDueAt");
