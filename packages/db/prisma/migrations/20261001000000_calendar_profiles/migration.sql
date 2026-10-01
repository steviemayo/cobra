-- Several calendar profiles per organisation; each room picks one and names its own calendar.
DROP INDEX "CalendarConnection_orgId_provider_key";
CREATE UNIQUE INDEX "CalendarConnection_orgId_name_key" ON "CalendarConnection"("orgId", "name");

ALTER TABLE "Room" ADD COLUMN "calendarConnectionId" UUID,
ADD COLUMN "calendarResource" TEXT;

ALTER TABLE "Room" ADD CONSTRAINT "Room_calendarConnectionId_fkey" FOREIGN KEY ("calendarConnectionId") REFERENCES "CalendarConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
