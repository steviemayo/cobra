-- AlterTable
ALTER TABLE "Member" ADD COLUMN "lastSeenAt" TIMESTAMP(3),
ADD COLUMN "recapSilenced" BOOLEAN NOT NULL DEFAULT false;
