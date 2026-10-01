import { describe, expect, it } from 'vitest';
import { compareVersions, latestVersions, publishedVersions, updateStatus } from './gateway-updates';

describe('gateway versions', () => {
  it('compare by number, not text, and ignore a leading v or a pre-release tag', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3-beta.4')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });

  it('read the latest version on each channel from the environment, ignoring junk', () => {
    expect(latestVersions({ GATEWAY_LATEST_STABLE: ' 1.4.0 ', GATEWAY_LATEST_BETA: 'soon' })).toEqual({
      stable: '1.4.0',
      beta: null,
    });
    expect(latestVersions({})).toEqual({ stable: null, beta: null });
  });

  it('say whether a gateway is behind the newest version on its own channel', () => {
    const latest = { stable: '1.4.0', beta: '1.5.0-beta.2' };
    expect(updateStatus({ version: '1.3.9', channel: 'stable' }, latest)).toEqual({ status: 'behind', latest: '1.4.0' });
    expect(updateStatus({ version: '1.4.0', channel: 'stable' }, latest).status).toBe('current');
    expect(updateStatus({ version: '1.4.0', channel: 'beta' }, latest).status).toBe('behind');
    expect(updateStatus({ version: '2.0.0', channel: 'stable' }, latest).status).toBe('current');
  });

  it('say unknown when either side does not know its version', () => {
    expect(updateStatus({ version: null, channel: 'stable' }, { stable: '1.0.0', beta: null }).status).toBe('unknown');
    expect(updateStatus({ version: '1.0.0', channel: 'beta' }, { stable: '1.0.0', beta: null }).status).toBe('unknown');
  });
});

describe('publishedVersions', () => {
  const read = (v: Record<string, string | null>) => async (c: 'stable' | 'beta') => v[c] ?? null;
  it('uses what is published, so a release nobody wrote into the setting still counts', async () => {
    const v = await publishedVersions({ GATEWAY_LATEST_STABLE: '0.4.0' }, read({ stable: '0.4.3', beta: null }));
    expect(v).toEqual({ stable: '0.4.3', beta: null });
    expect(updateStatus({ version: '0.4.0', channel: 'stable' }, v).status).toBe('behind');
  });
  it('keeps the setting when it is newer, or when the release cannot be read', async () => {
    expect(await publishedVersions({ GATEWAY_LATEST_STABLE: '0.5.0' }, read({ stable: '0.4.3' }))).toMatchObject({ stable: '0.5.0' });
    const failing = async () => {
      throw new Error('GitHub is down');
    };
    expect(await publishedVersions({ GATEWAY_LATEST_BETA: '0.4.1' }, failing)).toEqual({ stable: null, beta: '0.4.1' });
  });
});
