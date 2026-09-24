-- AlterTable
ALTER TABLE "Release" ADD COLUMN     "draftRevision" INTEGER;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "desiredDeploymentId" UUID,
ADD COLUMN     "reportedHash" TEXT;

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
    "gatewayId" UUID,
    "status" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'deploy',
    "scheduledFor" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deployment_roomId_createdAt_idx" ON "Deployment"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_orgId_createdAt_idx" ON "Deployment"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_status_scheduledFor_idx" ON "Deployment"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentEvent_deploymentId_stage_key" ON "DeploymentEvent"("deploymentId", "stage");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rooms that were already pointed at a release get a deployment for it, so every assignment has one.
INSERT INTO "Deployment" ("id", "orgId", "roomId", "releaseId", "gatewayId", "status", "kind", "createdAt", "startedAt", "finishedAt")
SELECT gen_random_uuid(), r."orgId", r."id", r."desiredReleaseId", r."gatewayId",
       CASE WHEN r."reportedReleaseId" = r."desiredReleaseId" THEN 'active' ELSE 'pending' END,
       'deploy', NOW(),
       CASE WHEN r."reportedReleaseId" = r."desiredReleaseId" THEN NOW() END,
       CASE WHEN r."reportedReleaseId" = r."desiredReleaseId" THEN NOW() END
FROM "Room" r
WHERE r."desiredReleaseId" IS NOT NULL AND r."gatewayId" IS NOT NULL;

UPDATE "Room" r SET "desiredDeploymentId" = d."id"
FROM "Deployment" d
WHERE d."roomId" = r."id" AND d."releaseId" = r."desiredReleaseId";
