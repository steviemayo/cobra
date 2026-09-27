-- AlterTable
ALTER TABLE "MspGrant" ADD COLUMN "useBrand" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProviderBrand" (
    "mspOrgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "accent" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderBrand_pkey" PRIMARY KEY ("mspOrgId")
);
