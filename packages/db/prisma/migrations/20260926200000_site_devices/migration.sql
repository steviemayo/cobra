-- AlterTable
ALTER TABLE "Release" ADD COLUMN "siteDeviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "SiteDevice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "control" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "values" JSONB NOT NULL DEFAULT '{}',
    "sealed" TEXT,
    "credentialSetId" UUID,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteDevice_orgId_idx" ON "SiteDevice"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDevice_siteId_name_key" ON "SiteDevice"("siteId", "name");

-- AddForeignKey
ALTER TABLE "SiteDevice" ADD CONSTRAINT "SiteDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDevice" ADD CONSTRAINT "SiteDevice_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

