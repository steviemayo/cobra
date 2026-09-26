import { describe, expect, it } from 'vitest';
import { BUILT_IN_DRIVERS } from '@kestrel/model';
import { LIBRARY } from './index';

describe('bundled drivers and their class', () => {
  it('every bundled driver declares a class and features, and they match what the device editor shows', () => {
    for (const [id, spec] of Object.entries(LIBRARY)) {
      expect(spec.class, id).toBeDefined();
      expect(spec.features?.length, id).toBeGreaterThan(0);
      expect(BUILT_IN_DRIVERS[id]?.class, id).toBe(spec.class);
      expect(BUILT_IN_DRIVERS[id]?.features, id).toEqual(spec.features);
    }
  });
});
