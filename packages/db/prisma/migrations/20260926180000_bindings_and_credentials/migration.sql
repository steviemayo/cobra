-- AlterTable
ALTER TABLE "Gateway" ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Room" ADD COLUMN "reportedBindingsVersion" INTEGER;

-- CreateTable
CREATE TABLE "RoomBinding" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "values" JSONB NOT NULL DEFAULT '{}',
    "sealed" TEXT,
    "credentialSets" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoomBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialSet" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CredentialSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomBinding_roomId_key" ON "RoomBinding"("roomId");
CREATE INDEX "RoomBinding_orgId_idx" ON "RoomBinding"("orgId");
CREATE UNIQUE INDEX "CredentialSet_orgId_name_key" ON "CredentialSet"("orgId", "name");

-- AddForeignKey
ALTER TABLE "RoomBinding" ADD CONSTRAINT "RoomBinding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomBinding" ADD CONSTRAINT "RoomBinding_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CredentialSet" ADD CONSTRAINT "CredentialSet_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
