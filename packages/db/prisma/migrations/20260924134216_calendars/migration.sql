-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarFire" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "triggerId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarFire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_orgId_provider_key" ON "CalendarConnection"("orgId", "provider");

-- CreateIndex
CREATE INDEX "CalendarFire_firedAt_idx" ON "CalendarFire"("firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarFire_roomId_triggerId_eventKey_key" ON "CalendarFire"("roomId", "triggerId", "eventKey");

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
