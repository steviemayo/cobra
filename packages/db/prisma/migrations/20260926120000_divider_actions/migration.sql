-- AlterTable
ALTER TABLE "RoomDivider" ADD COLUMN     "onOpen" TEXT NOT NULL DEFAULT 'follow',
ADD COLUMN     "onClose" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "open" BOOLEAN NOT NULL DEFAULT false;
