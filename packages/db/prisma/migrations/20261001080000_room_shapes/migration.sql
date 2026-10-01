-- CreateTable
CREATE TABLE "RoomShape" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slots" JSONB NOT NULL DEFAULT '[]',
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomShape_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomShape_orgId_idx" ON "RoomShape"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomShape_orgId_name_key" ON "RoomShape"("orgId", "name");

-- AddForeignKey
ALTER TABLE "RoomShape" ADD CONSTRAINT "RoomShape_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

