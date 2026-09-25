-- CreateTable
CREATE TABLE "StaffUser" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT,
    "roles" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAudit" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "orgId" UUID,
    "target" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_userId_key" ON "StaffUser"("userId");

-- CreateIndex
CREATE INDEX "StaffAudit_orgId_createdAt_idx" ON "StaffAudit"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffAudit_staffUserId_createdAt_idx" ON "StaffAudit"("staffUserId", "createdAt");

