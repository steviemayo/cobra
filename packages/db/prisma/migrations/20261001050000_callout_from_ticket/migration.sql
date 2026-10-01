-- A callout can be requested from an existing ticket, and goes to the service provider that covers it (or Kestrel).
ALTER TABLE "Callout" ADD COLUMN "ownsTicket" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "routedTo" TEXT NOT NULL DEFAULT 'kestrel';
