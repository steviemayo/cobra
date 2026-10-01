-- A command can be about a gateway rather than a room (finding devices on its network).
ALTER TABLE "RemoteCommand" ALTER COLUMN "roomId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "RemoteCommand_gatewayId_createdAt_idx" ON "RemoteCommand"("gatewayId", "createdAt");
