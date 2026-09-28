import type { DeviceState } from '@kestrel/model';
import { CrestronCwsMonitor, digPath } from './crestron-cws';
import { isRecord } from './nvx';

// Crestron 4-series control processors (RMC4, MC4, CP4, ...). Monitoring only, over the CresNext
// CWS REST API (see crestron-cws.ts).
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (15000), timeoutMs (4000).
//
// Beyond firmware, everything comes from control points named by a dotted path into the unit's
// /Device tree — most usefully a program slot's own status
// ("Device.Programs.ProgramInstanceLibrary.DeviceSlot1.Status") or one of its configured IP table
// entries ("...DeviceSlot1.IpTable.Entries.<IpId>.Status", ONLINE/OFFLINE): the processor's own view
// of whether it can reach a device on the network, watchable (`expect: "ONLINE"`) alongside that
// device's own monitoring.
export class Crestron4SeriesDriver extends CrestronCwsMonitor {
  protected applyFeedback(tree: unknown, s: DeviceState): void {
    const info = digPath(tree, 'Device.DeviceInfo');
    if (isRecord(info) && typeof info.DeviceVersion === 'string') s.firmware = info.DeviceVersion;
  }
}
