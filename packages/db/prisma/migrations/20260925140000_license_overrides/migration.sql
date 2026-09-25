-- CreateTable
CREATE TABLE "OrgLicenseOverride" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "plan" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "maxRooms" INTEGER,
    "unlimitedRooms" BOOLEAN NOT NULL DEFAULT false,
    "monitoring" BOOLEAN,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "setBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" UUID,

    CONSTRAINT "OrgLicenseOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgNote" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgLicenseOverride_orgId_createdAt_idx" ON "OrgLicenseOverride"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "OrgNote_orgId_createdAt_idx" ON "OrgNote"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrgLicenseOverride" ADD CONSTRAINT "OrgLicenseOverride_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgNote" ADD CONSTRAINT "OrgNote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

