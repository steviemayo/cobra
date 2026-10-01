-- CreateTable
CREATE TABLE "RoomBooking" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organiser" TEXT,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomBooking_roomId_eventId_startsAt_key" ON "RoomBooking"("roomId", "eventId", "startsAt");

-- CreateIndex
CREATE INDEX "RoomBooking_roomId_startsAt_idx" ON "RoomBooking"("roomId", "startsAt");

-- CreateIndex
CREATE INDEX "RoomBooking_orgId_idx" ON "RoomBooking"("orgId");

-- CreateIndex
CREATE INDEX "RoomBooking_endsAt_idx" ON "RoomBooking"("endsAt");
