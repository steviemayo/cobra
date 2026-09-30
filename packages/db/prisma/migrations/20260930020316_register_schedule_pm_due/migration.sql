-- AlterTable
ALTER TABLE "PmRun" ADD COLUMN     "dueOn" DATE;

-- CreateTable
CREATE TABLE "RegisterSchedule" (
    "orgId" UUID NOT NULL,
    "everyDays" INTEGER NOT NULL,
    "lastIssuedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegisterSchedule_pkey" PRIMARY KEY ("orgId")
);
