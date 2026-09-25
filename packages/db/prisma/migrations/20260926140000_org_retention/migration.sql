-- CreateTable
CREATE TABLE "OrgRetention" (
    "orgId" UUID NOT NULL,
    "auditDays" INTEGER NOT NULL DEFAULT 365,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgRetention_pkey" PRIMARY KEY ("orgId")
);
-- AddForeignKey
ALTER TABLE "OrgRetention" ADD CONSTRAINT "OrgRetention_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
