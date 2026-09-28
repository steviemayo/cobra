import type { DeviceState } from '@kestrel/model';
import { CrestronCwsMonitor, digPath } from './crestron-cws';
import { isRecord } from './nvx';

// Crestron TSW/TS touch panels (TSW-770, TS-1070, ...). Monitoring only, over the same CresNext CWS
// REST API as the 4-series driver (see crestron-cws.ts): the panel keeps running its own Crestron
// program and UI, Kestrel just watches it.
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (15000), timeoutMs (4000).
//
// Reports firmware, the screen's awake/asleep state as `power`, and the running app/project as
// `activeApp`. Any other field (proximity sensor, Bluetooth, ...) is available as a control point
// named by a dotted path into the panel's /Device tree, same as the 4-series driver.
export class CrestronTswDriver extends CrestronCwsMonitor {
  protected applyFeedback(tree: unknown, s: DeviceState): void {
    const info = digPath(tree, 'Device.DeviceInfo');
    if (isRecord(info) && typeof info.DeviceVersion === 'string') s.firmware = info.DeviceVersion;
    const display = digPath(tree, 'Device.Display');
    if (isRecord(display) && typeof display.CurrentState === 'string')
      s.power = display.CurrentState === 'On' ? 'on' : 'off';
    const apps = digPath(tree, 'Device.ThirdPartyApplications');
    if (isRecord(apps) && typeof apps.Mode === 'string') s.activeApp = apps.Mode;
  }
}
