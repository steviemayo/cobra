-- Devices on one network that go silent together are one problem: the group is an incident, its
-- members point at it.
ALTER TABLE "Incident" ADD COLUMN "parentId" UUID;

-- CreateIndex
CREATE INDEX "Incident_parentId_idx" ON "Incident"("parentId");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
