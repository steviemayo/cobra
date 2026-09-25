-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalatedBy" UUID,
ADD COLUMN     "routedTo" TEXT NOT NULL DEFAULT 'org',
ADD COLUMN     "staffAssignee" UUID;

-- AlterTable
ALTER TABLE "TicketComment" ADD COLUMN     "fromStaff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public';

-- CreateIndex
CREATE INDEX "Ticket_routedTo_status_createdAt_idx" ON "Ticket"("routedTo", "status", "createdAt");

