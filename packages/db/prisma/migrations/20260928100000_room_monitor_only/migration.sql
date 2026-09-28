-- A room that is only watched: its design warnings are not shown as something to fix.
ALTER TABLE "Room" ADD COLUMN "monitorOnly" BOOLEAN NOT NULL DEFAULT false;
