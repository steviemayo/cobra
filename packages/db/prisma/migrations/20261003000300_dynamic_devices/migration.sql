-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "addressHistory" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "addressMode" TEXT NOT NULL DEFAULT 'fixed',
ADD COLUMN     "addressSuggestion" JSONB,
ADD COLUMN     "hostname" TEXT,
ADD COLUMN     "refindAt" TIMESTAMP(3);
