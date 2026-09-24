-- CreateTable
CREATE TABLE "RoomDraft" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "model" JSONB NOT NULL,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomDraftVersion" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "label" TEXT,
    "model" JSONB NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomDraftVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "roomType" "RoomType" NOT NULL,
    "model" JSONB NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomDraft_roomId_key" ON "RoomDraft"("roomId");

-- CreateIndex
CREATE INDEX "RoomDraft_orgId_idx" ON "RoomDraft"("orgId");

-- CreateIndex
CREATE INDEX "RoomDraftVersion_draftId_createdAt_idx" ON "RoomDraftVersion"("draftId", "createdAt");

-- CreateIndex
CREATE INDEX "RoomDraftVersion_orgId_idx" ON "RoomDraftVersion"("orgId");

-- CreateIndex
CREATE INDEX "Template_orgId_idx" ON "Template"("orgId");

-- AddForeignKey
ALTER TABLE "RoomDraft" ADD CONSTRAINT "RoomDraft_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDraft" ADD CONSTRAINT "RoomDraft_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDraftVersion" ADD CONSTRAINT "RoomDraftVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomDraftVersion" ADD CONSTRAINT "RoomDraftVersion_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RoomDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
