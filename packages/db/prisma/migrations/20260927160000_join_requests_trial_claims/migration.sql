-- CreateTable
CREATE TABLE "JoinRequest" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "role" "OrgRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "JoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrialClaim" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emailKey" TEXT,
    "domainKey" TEXT,
    "orgId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JoinRequest_orgId_status_idx" ON "JoinRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "JoinRequest_userId_createdAt_idx" ON "JoinRequest"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrialClaim_userId_key" ON "TrialClaim"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrialClaim_emailKey_key" ON "TrialClaim"("emailKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrialClaim_domainKey_key" ON "TrialClaim"("domainKey");

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
