-- A number for each ticket, the one a service desk (ServiceNow, ConnectWise) and people quote.
-- Existing tickets are numbered in the order they were raised, then new ones carry on from there.
CREATE SEQUENCE "Ticket_number_seq";

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "number" INTEGER;

UPDATE "Ticket" t
SET "number" = n.rank
FROM (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS rank FROM "Ticket"
) n
WHERE t."id" = n."id";

SELECT setval('"Ticket_number_seq"', COALESCE((SELECT max("number") FROM "Ticket"), 0) + 1, false);

ALTER TABLE "Ticket"
  ALTER COLUMN "number" SET NOT NULL,
  ALTER COLUMN "number" SET DEFAULT nextval('"Ticket_number_seq"');

ALTER SEQUENCE "Ticket_number_seq" OWNED BY "Ticket"."number";

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");
