import type { DeviceDetailSection, DeviceState } from '@kestrel/model';
import { CrestronCwsMonitor } from './crestron-cws';
import { deviceSection, ipTableSection, rows, text } from './crestron-details';
import { digPath, isRecord } from './cresnext';

// Crestron TSW/TS touch panels (TSW-770, TS-1070, ...). Monitoring only, over the same CresNext CWS
// REST API as the 4-series driver (see crestron-cws.ts): the panel keeps running its own Crestron
// program and UI, Kestrel just watches it.
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (15000), timeoutMs (4000).
//
// Reports firmware, the screen's awake/asleep state as `power`, and the running app/project as
// `activeApp`, plus details for the portal's device page: what identifies the panel (model, serial
// number, MAC), the screen and proximity settings, the loaded project and the IP table (the control
// systems it connects to). Any other field is available as a control point named by a dotted path
// into the panel's /Device tree, same as the 4-series driver.
export class CrestronTswDriver extends CrestronCwsMonitor {
  protected applyFeedback(tree: unknown, s: DeviceState): void {
    const info = digPath(tree, 'Device.DeviceInfo');
    if (isRecord(info) && typeof info.DeviceVersion === 'string') s.firmware = info.DeviceVersion;
    const display = digPath(tree, 'Device.Display');
    if (isRecord(display) && typeof display.CurrentState === 'string')
      s.power = display.CurrentState === 'On' ? 'on' : 'off';
    const apps = digPath(tree, 'Device.ThirdPartyApplications');
    if (isRecord(apps) && typeof apps.Mode === 'string') s.activeApp = apps.Mode;

    const sections: DeviceDetailSection[] = [];
    const device = deviceSection(tree);
    if (device) sections.push(device);

    const screen = [
      ...rows(display, [['CurrentState', 'Screen']]),
      ...rows(digPath(tree, 'Device.Display.Lcd'), [
        ['Brightness', 'Brightness'],
        ['StandbyTimeoutMinutes', 'Screen off after (minutes)'],
      ]),
      ...rows(digPath(tree, 'Device.ProximitySensor'), [
        ['IsWakeOnProximityEnabled', 'Wake on proximity'],
      ]),
    ];
    if (screen.length) sections.push({ title: 'Screen', rows: screen });

    // The project the panel is running (a Crestron project, or one of the app modes).
    const project = [
      ...rows(apps, [['Mode', 'Application mode']]),
      ...rows(digPath(tree, 'Device.UiUserProject'), [
        ['ProjectName', 'Project'],
        ['CompiledOn', 'Compiled'],
      ]),
    ];
    if (project.length) sections.push({ title: 'Project', rows: project });

    // IpTableV2 is the newer copy of the same table; fall back to the original on older firmware.
    const ip =
      ipTableSection('IP table', digPath(tree, 'Device.IpTableV2.Entries')) ??
      ipTableSection('IP table', digPath(tree, 'Device.IpTable.Entries'));
    if (ip) sections.push(ip);
    const bluetooth = text(digPath(tree, 'Device.Bluetooth.IsEnabled'));
    if (bluetooth)
      sections.push({
        title: 'Connectivity',
        rows: [{ label: 'Bluetooth', value: bluetooth === 'true' ? 'On' : 'Off' }],
      });
    s.details = sections;
  }
}
