-- CreateTable
CREATE TABLE "DriverRequest" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "deviceId" UUID,
    "ticketId" UUID,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "need" TEXT NOT NULL DEFAULT 'monitor',
    "protocol" TEXT NOT NULL DEFAULT 'unknown',
    "docsUrl" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "driverSlug" TEXT,
    "staffNote" TEXT,
    "requestedBy" UUID,
    "requestedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverRequest_orgId_status_idx" ON "DriverRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "DriverRequest_status_createdAt_idx" ON "DriverRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DriverRequest_make_model_idx" ON "DriverRequest"("make", "model");

-- AddForeignKey
ALTER TABLE "DriverRequest" ADD CONSTRAINT "DriverRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
