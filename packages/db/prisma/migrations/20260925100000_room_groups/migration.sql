-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "groupId" UUID,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "memberRoomIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "RoomGroup" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomDivider" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "roomIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomDivider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomGroup_orgId_idx" ON "RoomGroup"("orgId");

-- CreateIndex
CREATE INDEX "RoomGroup_siteId_idx" ON "RoomGroup"("siteId");

-- CreateIndex
CREATE INDEX "RoomDivider_groupId_idx" ON "RoomDivider"("groupId");

-- CreateIndex
CREATE INDEX "Room_groupId_idx" ON "Room"("groupId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RoomGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomGroup" ADD CONSTRAINT "RoomGroup_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomGroup" ADD CONSTRAINT "RoomGroup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDivider" ADD CONSTRAINT "RoomDivider_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RoomGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

