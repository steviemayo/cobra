-- Whatever a device's driver reports back (power, input, mute, ...), control or not.
ALTER TABLE "DeviceStatus" ADD COLUMN "feedback" JSONB;
