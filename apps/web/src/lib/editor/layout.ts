import { DEVICE_CATALOG, type Device } from '@kestrel/model';

const COLUMN: Record<string, number> = {
  source: 0,
  camera: 0,
  mic: 0,
  conference: 1,
  matrix: 1,
  destination: 2,
  environment: 3,
};

export function autoLayout(
  devices: Device[],
  rowGap = 180,
): Record<string, { x: number; y: number }> {
  const rows: Record<number, number> = {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const d of devices) {
    const col = COLUMN[DEVICE_CATALOG[d.category].section] ?? 0;
    const row = (rows[col] = (rows[col] ?? -1) + 1);
    out[d.id] = { x: col * 320, y: row * rowGap };
  }
  return out;
}
