-- CreateTable
CREATE TABLE "RoomCombination" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "primaryRoomId" UUID NOT NULL,
    "secondaryRoomIds" UUID[],
    "secondaryVideo" TEXT NOT NULL DEFAULT 'follow',
    "secondaryAudio" TEXT NOT NULL DEFAULT 'follow',
    "combined" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomCombination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomCombination_orgId_idx" ON "RoomCombination"("orgId");

-- AddForeignKey
ALTER TABLE "RoomCombination" ADD CONSTRAINT "RoomCombination_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
