-- AlterTable
ALTER TABLE "MspGrant" ADD COLUMN     "accountManager" TEXT,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
