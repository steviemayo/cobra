-- CreateTable
CREATE TABLE "DeviceStatus" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID,
    "gatewayId" UUID,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedBy" UUID,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertChannel" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "minSeverity" TEXT NOT NULL DEFAULT 'warning',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "incidentId" UUID,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteCommand" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" UUID,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RemoteCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID,
    "incidentId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "createdBy" UUID,
    "createdByEmail" TEXT,
    "assignedTo" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketComment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorId" UUID,
    "authorEmail" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceStatus_orgId_idx" ON "DeviceStatus"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceStatus_roomId_deviceId_key" ON "DeviceStatus"("roomId", "deviceId");

-- CreateIndex
CREATE INDEX "Incident_orgId_status_openedAt_idx" ON "Incident"("orgId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "Incident_orgId_kind_subject_status_idx" ON "Incident"("orgId", "kind", "subject", "status");

-- CreateIndex
CREATE INDEX "Incident_roomId_idx" ON "Incident"("roomId");

-- CreateIndex
CREATE INDEX "AlertChannel_orgId_idx" ON "AlertChannel"("orgId");

-- CreateIndex
CREATE INDEX "AlertDelivery_channelId_at_idx" ON "AlertDelivery"("channelId", "at");

-- CreateIndex
CREATE INDEX "AlertDelivery_orgId_at_idx" ON "AlertDelivery"("orgId", "at");

-- CreateIndex
CREATE INDEX "RemoteCommand_gatewayId_status_idx" ON "RemoteCommand"("gatewayId", "status");

-- CreateIndex
CREATE INDEX "RemoteCommand_roomId_createdAt_idx" ON "RemoteCommand"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "RemoteCommand_orgId_createdAt_idx" ON "RemoteCommand"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_orgId_status_createdAt_idx" ON "Ticket"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_roomId_idx" ON "Ticket"("roomId");

-- CreateIndex
CREATE INDEX "TicketComment_ticketId_createdAt_idx" ON "TicketComment"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeviceStatus" ADD CONSTRAINT "DeviceStatus_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStatus" ADD CONSTRAINT "DeviceStatus_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertChannel" ADD CONSTRAINT "AlertChannel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteCommand" ADD CONSTRAINT "RemoteCommand_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteCommand" ADD CONSTRAINT "RemoteCommand_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
