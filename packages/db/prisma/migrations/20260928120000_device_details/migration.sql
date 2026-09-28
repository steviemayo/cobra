-- What a device says about itself (serial, programs, IP table, ...), as the gateway reports it.
ALTER TABLE "DeviceStatus" ADD COLUMN "details" JSONB;
