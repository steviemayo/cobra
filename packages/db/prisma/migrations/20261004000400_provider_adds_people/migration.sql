-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "viaMspOrgId" UUID;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "addedByMspOrgId" UUID;

-- AlterTable
ALTER TABLE "MspGrant" ADD COLUMN     "mayAddPeople" BOOLEAN NOT NULL DEFAULT false;

-- A customer a provider created itself (the provider answered its own invitation) already trusts it with its team.
UPDATE "MspGrant" SET "mayAddPeople" = true WHERE "status" = 'active' AND "role" = 'manage' AND "respondedBy" = "invitedBy" AND cardinality("siteIds") = 0;
