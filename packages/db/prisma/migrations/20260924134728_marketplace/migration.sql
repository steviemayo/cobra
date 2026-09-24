-- CreateTable
CREATE TABLE "MarketplaceListing" (
    "id" UUID NOT NULL,
    "publisherOrgId" UUID NOT NULL,
    "templateId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "roomType" "RoomType" NOT NULL,
    "model" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'aud',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplacePurchase" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "buyerOrgId" UUID NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "stripeSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplacePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_createdAt_idx" ON "MarketplaceListing"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceListing_publisherOrgId_idx" ON "MarketplaceListing"("publisherOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplacePurchase_stripeSessionId_key" ON "MarketplacePurchase"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplacePurchase_listingId_buyerOrgId_key" ON "MarketplacePurchase"("listingId", "buyerOrgId");

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_publisherOrgId_fkey" FOREIGN KEY ("publisherOrgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplacePurchase" ADD CONSTRAINT "MarketplacePurchase_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplacePurchase" ADD CONSTRAINT "MarketplacePurchase_buyerOrgId_fkey" FOREIGN KEY ("buyerOrgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
