import { describe, expect, it } from 'vitest';
import type { GatewayCommand } from '@kestrel/model';
import { runCommand } from './commands';
import type { RoomHost } from './room-host';

const ROOM = '33333333-3333-4333-8333-333333333331';
const host = {
  get: () => ({ signed: { manifest: { model: { devices: [] }, roomName: 'Boardroom', releaseNumber: 1 } } }),
} as unknown as RoomHost;
const facts = { version: 'test', uptimeSeconds: 1, bufferedEvents: 0 };
const cmd = (args: Record<string, string> = {}): GatewayCommand => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'discover_devices',
  roomId: ROOM,
  args,
});

describe('the discover command', () => {
  it('refuses something that is not a network address', async () => {
    for (const subnet of ['192.168.1.0/24', 'x', '1.2.3.4', '10.0']) {
      const r = await runCommand(host, cmd({ subnet }), facts);
      expect(r).toMatchObject({ ok: false, error: 'That is not a network address' });
    }
  });

  it('refuses a network the gateway is not on, without scanning it', async () => {
    const r = await runCommand(host, cmd({ subnet: '203.0.113' }), facts);
    expect(r).toMatchObject({ ok: false, error: 'The gateway is not on that network' });
    expect(r.output).toMatchObject({ subnets: [], hostsScanned: 0, found: [] });
  });
});
