-- A problem that opens while a meeting is on (or about to start) is marked, and its severity raised a step.
ALTER TABLE "Incident" ADD COLUMN "meetingsAffected" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Incident" ADD COLUMN "severityRaised" BOOLEAN NOT NULL DEFAULT false;
