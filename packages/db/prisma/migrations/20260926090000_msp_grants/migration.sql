-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'customer';

-- CreateTable
CREATE TABLE "MspGrant" (
    "id" UUID NOT NULL,
    "mspOrgId" UUID NOT NULL,
    "customerOrgId" UUID NOT NULL,
    "siteIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invitedBy" UUID NOT NULL,
    "invitedByEmail" TEXT,
    "respondedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" UUID,

    CONSTRAINT "MspGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MspGrant_customerOrgId_status_idx" ON "MspGrant"("customerOrgId", "status");

-- CreateIndex
CREATE INDEX "MspGrant_mspOrgId_status_idx" ON "MspGrant"("mspOrgId", "status");

-- AddForeignKey
ALTER TABLE "MspGrant" ADD CONSTRAINT "MspGrant_mspOrgId_fkey" FOREIGN KEY ("mspOrgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MspGrant" ADD CONSTRAINT "MspGrant_customerOrgId_fkey" FOREIGN KEY ("customerOrgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

