import { describe, expect, it } from 'vitest';
import { AssetCategory, BUILT_IN_DRIVERS, DRIVER_GROUPS } from '../index';

describe('built-in driver labels', () => {
  const all = Object.entries(BUILT_IN_DRIVERS);

  it('every driver is labelled Category – Make Model and sits in a known group', () => {
    for (const [id, d] of all) {
      expect(d.label, id).toMatch(/^[^–]+ – .+/);
      expect(d.group in DRIVER_GROUPS, id).toBe(true);
    }
  });

  it('labels are unique, so the picker never shows two the same', () => {
    const labels = all.map(([, d]) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every category a driver names is a real category', () => {
    for (const [id, d] of all)
      for (const c of d.categories) expect(AssetCategory.safeParse(c).success, `${id}: ${c}`).toBe(true);
  });

  it('the basic Blustream power driver stays loadable but is not offered', () => {
    expect(BUILT_IN_DRIVERS['lib:blustream-pwr8iec']?.hidden).toBe(true);
    expect(BUILT_IN_DRIVERS['blustream-pwr']?.hidden).toBeUndefined();
  });

  it('uses the names asked for', () => {
    expect(BUILT_IN_DRIVERS['crestron-tsw']?.label).toBe('Touch panel – Crestron 70 Series Touch');
    expect(BUILT_IN_DRIVERS['crestron-occupancy']?.label).toBe('Sensor – Crestron CEN-ODT-C-POE');
  });
});
