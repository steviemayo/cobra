-- CreateTable
CREATE TABLE "RoomSchedule" (
    "roomId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "meetings" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomSchedule_pkey" PRIMARY KEY ("roomId")
);

-- CreateIndex
CREATE INDEX "RoomSchedule_orgId_idx" ON "RoomSchedule"("orgId");
