-- Support callouts: request, quote, prepay, complete, invoice or refund.
CREATE TABLE "Callout" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID,
    "roomId" UUID,
    "ticketId" UUID,
    "incidentId" UUID,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "preferredDates" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "createdBy" UUID,
    "createdByEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hours" DOUBLE PRECISION,
    "rateCents" INTEGER,
    "subtotalCents" INTEGER,
    "gstCents" INTEGER,
    "totalCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'aud',
    "quoteNote" TEXT,
    "quotedAt" TIMESTAMP(3),
    "quotedBy" UUID,
    "scheduledFor" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "stripeSessionId" TEXT,
    "paymentIntentId" TEXT,
    "prepaidInvoiceId" TEXT,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "actualHours" DOUBLE PRECISION,
    "completionNote" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" UUID,
    "stripeInvoiceId" TEXT,
    "invoiceUrl" TEXT,
    "invoicedCents" INTEGER,
    "creditNoteId" TEXT,
    "refundedCents" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "Callout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Callout_stripeSessionId_key" ON "Callout"("stripeSessionId");
CREATE INDEX "Callout_orgId_status_createdAt_idx" ON "Callout"("orgId", "status", "createdAt");
CREATE INDEX "Callout_status_createdAt_idx" ON "Callout"("status", "createdAt");

ALTER TABLE "Callout" ADD CONSTRAINT "Callout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
