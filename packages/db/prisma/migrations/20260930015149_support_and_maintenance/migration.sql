-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "deviceId" UUID,
ADD COLUMN     "rootCause" TEXT,
ADD COLUMN     "ruleEscalated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ruleId" UUID;

-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "repeatUntil" TIMESTAMP(3),
    "reason" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketRule" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minSeverity" TEXT NOT NULL DEFAULT 'warning',
    "siteIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "afterMinutes" INTEGER NOT NULL DEFAULT 10,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "routeTo" TEXT NOT NULL DEFAULT 'org',
    "escalateAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "escalatePriority" TEXT NOT NULL DEFAULT 'high',
    "escalateTo" TEXT NOT NULL DEFAULT 'kestrel',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItsmConnector" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "sealedSecret" TEXT,
    "inboundHash" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItsmConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItsmLink" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "externalRef" TEXT NOT NULL,
    "lastStatus" TEXT,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItsmLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItsmSyncLog" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "ticketId" UUID,
    "direction" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "summary" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItsmSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisterIssue" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'register',
    "number" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'org',
    "scopeId" UUID,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "takenBy" UUID,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegisterIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmTemplate" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT 'room',
    "category" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmSchedule" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "roomId" UUID,
    "deviceId" UUID,
    "intervalDays" INTEGER NOT NULL,
    "nextDueOn" DATE NOT NULL,
    "leadDays" INTEGER NOT NULL DEFAULT 7,
    "assigneeUserId" UUID,
    "assigneeMspOrgId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunOn" DATE,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmRun" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "scheduleId" UUID,
    "templateId" UUID NOT NULL,
    "templateName" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "roomId" UUID,
    "deviceId" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "results" JSONB NOT NULL DEFAULT '[]',
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "startedBy" UUID,
    "signedBy" UUID,
    "signedByName" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenanceWindow_orgId_startsAt_idx" ON "MaintenanceWindow"("orgId", "startsAt");

-- CreateIndex
CREATE INDEX "TicketRule_orgId_sortOrder_idx" ON "TicketRule"("orgId", "sortOrder");

-- CreateIndex
CREATE INDEX "ItsmConnector_orgId_idx" ON "ItsmConnector"("orgId");

-- CreateIndex
CREATE INDEX "ItsmLink_connectorId_externalRef_idx" ON "ItsmLink"("connectorId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ItsmLink_ticketId_connectorId_key" ON "ItsmLink"("ticketId", "connectorId");

-- CreateIndex
CREATE INDEX "ItsmSyncLog_connectorId_at_idx" ON "ItsmSyncLog"("connectorId", "at");

-- CreateIndex
CREATE INDEX "RegisterIssue_orgId_takenAt_idx" ON "RegisterIssue"("orgId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegisterIssue_orgId_kind_number_key" ON "RegisterIssue"("orgId", "kind", "number");

-- CreateIndex
CREATE INDEX "PmTemplate_orgId_idx" ON "PmTemplate"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PmTemplate_orgId_name_key" ON "PmTemplate"("orgId", "name");

-- CreateIndex
CREATE INDEX "PmSchedule_orgId_nextDueOn_idx" ON "PmSchedule"("orgId", "nextDueOn");

-- CreateIndex
CREATE INDEX "PmSchedule_roomId_idx" ON "PmSchedule"("roomId");

-- CreateIndex
CREATE INDEX "PmRun_orgId_createdAt_idx" ON "PmRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PmRun_roomId_idx" ON "PmRun"("roomId");

-- CreateIndex
CREATE INDEX "PmRun_deviceId_idx" ON "PmRun"("deviceId");
