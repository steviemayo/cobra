import { describe, expect, it } from 'vitest';
import type { GatewayCommand } from '@kestrel/model';
import { runCommand } from './commands';
import type { DeviceHost } from './device-host';

const cmd = (args: Record<string, string>): GatewayCommand => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'snapshot',
  roomId: '00000000-0000-0000-0000-000000000000',
  args,
});

describe('the snapshot command', () => {
  it('returns the picture the device host took, under the command’s id', async () => {
    const host = {
      snapshot: async (id: string) =>
        id === 'cam'
          ? { ok: true as const, contentType: 'image/jpeg' as const, data: '/9j/4A==' }
          : { ok: false as const, error: 'This gateway is not polling that device yet' },
    } as unknown as DeviceHost;
    expect(await runCommand(cmd({ deviceId: 'cam' }), host)).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      ok: true,
      output: { contentType: 'image/jpeg', data: '/9j/4A==' },
    });
    expect(await runCommand(cmd({ deviceId: 'other' }), host)).toMatchObject({
      ok: false,
      error: 'This gateway is not polling that device yet',
    });
  });

  it('refuses a command with no device', async () => {
    const host = {} as unknown as DeviceHost;
    expect(await runCommand(cmd({}), host)).toMatchObject({ ok: false });
    expect(await runCommand(cmd({ deviceId: 'cam' }))).toMatchObject({ ok: false });
  });
});
