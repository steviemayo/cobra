import { execFile } from 'node:child_process';
import { normaliseMac } from '@kestrel/model';

// The gateway's own ARP table: which MAC answered for which address on the networks it sits on. It
// is how a device that has moved to a new address is recognised, and it only ever knows about
// devices on the same network segment as the gateway. Reading it changes nothing.

/** One line of `arp -a` on Windows, Linux or macOS, as address and MAC, or null if it has neither. */
function parseLine(line: string): [string, string] | null {
  const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line)?.[1];
  const raw = /\b((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})\b/i.exec(line)?.[1];
  if (!ip || !raw) return null;
  // macOS leaves out leading zeros (a:b:c:d:e:f).
  const mac = normaliseMac(
    raw
      .split(/[:-]/)
      .map((p) => p.padStart(2, '0'))
      .join(':'),
  );
  if (!mac || mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') return null;
  // Multicast and broadcast entries are not devices.
  if (/^(22[4-9]|23\d|255)\./.test(ip)) return null;
  return [ip, mac];
}

/** Address to MAC for every complete entry in the text of an ARP table. */
export function parseArp(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const hit = parseLine(line);
    if (hit) out.set(hit[0], hit[1]);
  }
  return out;
}

export type ArpReader = () => Promise<Map<string, string>>;

/** Reads the system's ARP table with `arp -a`. An empty table (and no error) if it cannot be read. */
export const readArp: ArpReader = () =>
  new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? new Map() : parseArp(String(stdout))),
    );
  });
