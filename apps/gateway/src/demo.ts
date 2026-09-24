// Runs a whole Kestrel site on one machine, for development and demos:
//   a fake cloud -> the real gateway -> simulated devices -> the real panel app over WebSocket.
//
//   pnpm --filter @kestrel/panel-app build && pnpm --filter @kestrel/gateway demo
//
// Then open the printed panel URL. Plug a cable in with:  curl -X POST localhost:4101/plug/laptop1/1
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPin } from '@kestrel/crypto';
import { STARTER_TEMPLATES } from '@kestrel/model';
import type { Simulation } from '@kestrel/drivers';
import { CloudClient } from './cloud';
import { Gateway } from './gateway';
import { createLogger } from './log';
import { createPanelServer } from './panel-server';
import { RoomHost } from './room-host';
import { Store } from './store';
import { ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const ROOM_ID = '33333333-3333-4333-8333-333333333331';
const PANEL_PORT = Number(process.env.DEMO_PANEL_PORT ?? 8080);
const CONTROL_PORT = Number(process.env.DEMO_CONTROL_PORT ?? 4101);
const pin = process.env.DEMO_PIN;

const log = createLogger('info');
const cloud = await new FakeCloud().start(Number(process.env.DEMO_CLOUD_PORT ?? 4100));
const template = STARTER_TEMPLATES.find((t) => t.id === (process.env.DEMO_TEMPLATE ?? 'training-recorded'))!;
const model = structuredClone(template.model);
model.settings.autoOff = { enabled: true, idleSeconds: 30, warnSeconds: 10 };
cloud.assign(ROOM_ID, model, { name: 'Lecture Theatre 1' });

const store = new Store(join(mkdtempSync(join(tmpdir(), 'kestrel-demo-')), 'gateway.db'));
const host = new RoomHost('all', log, (e) => store.enqueue(e));
const gateway = new Gateway(
  {
    cloudUrl: cloud.url,
    enrollToken: ENROLL_TOKEN,
    dataDir: '',
    panelPort: PANEL_PORT,
    panelHost: '0.0.0.0',
    panelDir: resolve(import.meta.dirname, '../../panel/dist'),
    simulate: 'all',
    logLevel: 'info',
    version: 'demo',
  },
  store,
  new CloudClient(cloud.url),
  host,
  log,
);

// Optionally protect the panel with a PIN (DEMO_PIN=1234) to try the keypad.
if (pin) {
  const original = host.load.bind(host);
  host.load = (signed) => {
    signed.manifest.panel.access = { mode: 'pin', pinHash: hashPin(pin), trustedIps: [] };
    return original(signed);
  };
}

const panel = await createPanelServer({
  host,
  log,
  panelDir: resolve(import.meta.dirname, '../../panel/dist'),
});
await panel.listen({ port: PANEL_PORT, host: '0.0.0.0' });
gateway.start();

// A tiny control surface standing in for "a person plugging a laptop in".
createServer((req, res) => {
  const m = /^\/plug\/([\w-]+)\/([01])$/.exec(req.url ?? '');
  const room = host.get(ROOM_ID);
  if (req.method === 'POST' && m && room) {
    try {
      (room.bus as Simulation).plug(m[1]!, m[2] === '1');
      res.writeHead(200).end('ok\n');
    } catch (e) {
      res.writeHead(400).end(`${String(e)}\n`);
    }
  } else res.writeHead(404).end('POST /plug/<deviceId>/<0|1>\n');
}).listen(CONTROL_PORT, '127.0.0.1');

setTimeout(() => {
  console.log(`\nPanel:   http://localhost:${PANEL_PORT}/room/${ROOM_ID}${pin ? `   (PIN ${pin})` : ''}`);
  console.log(`Devices: ${model.devices.filter((d) => d.category === 'video_source').map((d) => d.id).join(', ')}`);
  console.log(`Plug in: curl -X POST http://localhost:${CONTROL_PORT}/plug/laptop1/1   (…/0 to unplug)\n`);
}, 800);
