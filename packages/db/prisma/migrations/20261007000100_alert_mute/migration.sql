-- Mute alert notifications per organisation, site or room. Incidents are still raised.
ALTER TABLE "Org" ADD COLUMN "alertsMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "alertsMutedUntil" TIMESTAMP(3);

ALTER TABLE "Site" ADD COLUMN "alertsMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "alertsMutedUntil" TIMESTAMP(3);

ALTER TABLE "Room" ADD COLUMN "alertsMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "alertsMutedUntil" TIMESTAMP(3);
