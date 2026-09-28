import type { DetailStatus, DeviceDetailSection, DeviceState } from '@kestrel/model';
import { CrestronCwsMonitor } from './crestron-cws';
import { deviceSection, ipTableSection, rows, text } from './crestron-details';
import { digPath, isRecord } from './cresnext';

// Crestron 4-series control processors (RMC4, MC4, CP4, ...). Monitoring only, over the CresNext
// CWS REST API (see crestron-cws.ts).
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (15000), timeoutMs (4000).
//
// Reports firmware and a set of details for the portal's device page: what identifies the unit
// (model, serial number, MAC), each program slot that has a program loaded (its code name, when it
// was compiled and by whom, whether it is running) and that program's IP table (which units it is
// set up to talk to and whether each is connected). Beyond that, any control point named by a
// dotted path into the unit's /Device tree can be read or watched, most usefully a program slot's
// own status ("Device.Programs.ProgramInstanceLibrary.DeviceSlot1.Status") or an IP table entry's
// ("...DeviceSlot1.IpTable.Entries.<IpId>.Status", ONLINE/OFFLINE): the processor's own view of
// whether it can reach a device on the network, watchable (`expect: "ONLINE"`) alongside that
// device's own monitoring.

/** One slot's program, if it has one: the fields that name it and say when it was built. */
function programSection(
  slotKey: string,
  slot: Record<string, unknown>,
): DeviceDetailSection | undefined {
  const registered = text(slot.RegistrationStatus);
  const details = slot.ProgramDetails;
  // An empty slot still has details ("No Program Loaded"); only a program with a name is worth a section.
  if (!isRecord(details) || !(text(details.SystemName) || text(details.FriendlyName)))
    return undefined;
  const status = text(slot.Status);
  const state: DetailStatus | undefined = /^started$/i.test(status ?? '')
    ? 'ok'
    : status
      ? 'warning'
      : undefined;
  const slotNumber = text(slot.Slot) ?? slotKey.replace(/^DeviceSlot/, '');
  return {
    title: `Program, slot ${slotNumber}`,
    rows: [
      ...(status ? [{ label: 'Status', value: status, ...(state ? { status: state } : {}) }] : []),
      ...rows({ RegistrationStatus: registered }, [['RegistrationStatus', 'Registration']]),
      ...rows(details, [
        ['SystemName', 'Code name'],
        ['FriendlyName', 'Program name'],
        ['ProgramFileName', 'Program file'],
        ['CompiledOn', 'Compiled'],
        ['Programmer', 'Programmer'],
        ['ProgrammingEnvironment', 'Built with'],
        ['TargetDevice', 'Target device'],
        ['LastStarted', 'Last started'],
      ]),
    ],
  };
}

export class Crestron4SeriesDriver extends CrestronCwsMonitor {
  protected applyFeedback(tree: unknown, s: DeviceState): void {
    const info = digPath(tree, 'Device.DeviceInfo');
    if (isRecord(info) && typeof info.DeviceVersion === 'string') s.firmware = info.DeviceVersion;

    const sections: DeviceDetailSection[] = [];
    const device = deviceSection(tree);
    if (device) sections.push(device);
    const slots = digPath(tree, 'Device.Programs.ProgramInstanceLibrary');
    if (isRecord(slots))
      for (const [key, slot] of Object.entries(slots).sort(([a], [b]) =>
        a.localeCompare(b, 'en', { numeric: true }),
      )) {
        if (!isRecord(slot)) continue;
        const program = programSection(key, slot);
        if (!program) continue;
        sections.push(program);
        const ip = ipTableSection(
          `IP table, slot ${text(slot.Slot) ?? key}`,
          digPath(slot, 'IpTable.Entries'),
        );
        if (ip) sections.push(ip);
      }
    s.details = sections;
  }
}
