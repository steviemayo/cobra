-- Control points read on a monitored device (a DSP's gain blocks, routers, named controls) and their last readings.
ALTER TABLE "Device" ADD COLUMN "points" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "pointValues" JSONB;
