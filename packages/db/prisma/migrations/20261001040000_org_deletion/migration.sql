-- An organisation scheduled for deletion by staff: switched off now, deleted for good on deleteAfter.
ALTER TABLE "Org" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deleteAfter" TIMESTAMP(3),
ADD COLUMN "deletedBy" UUID,
ADD COLUMN "deleteReason" TEXT;
