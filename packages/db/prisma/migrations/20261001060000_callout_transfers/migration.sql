-- Callouts: a history of who had it and what was done, and who completed it (a service provider can complete one).
ALTER TABLE "Callout" ADD COLUMN "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "completedByName" TEXT;
