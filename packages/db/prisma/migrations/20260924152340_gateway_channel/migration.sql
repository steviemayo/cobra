-- CreateEnum
CREATE TYPE "GatewayChannel" AS ENUM ('stable', 'beta');

-- AlterTable
ALTER TABLE "Gateway" ADD COLUMN     "channel" "GatewayChannel" NOT NULL DEFAULT 'stable';
