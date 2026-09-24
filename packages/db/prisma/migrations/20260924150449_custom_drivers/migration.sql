-- CreateTable
CREATE TABLE "CustomDriver" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latestVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomDriver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomDriverVersion" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomDriverVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomDriver_orgId_slug_key" ON "CustomDriver"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CustomDriverVersion_driverId_version_key" ON "CustomDriverVersion"("driverId", "version");

-- AddForeignKey
ALTER TABLE "CustomDriver" ADD CONSTRAINT "CustomDriver_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomDriverVersion" ADD CONSTRAINT "CustomDriverVersion_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "CustomDriver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
