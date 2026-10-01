import { connect } from 'node:net';
import { isLinkLocal, localAddressAllowed } from './address-guard';

// Shared plumbing for the family of plain ASCII, prompt-based TCP consoles used by drivers such as
// the Blustream ACM1000 and DA11ABL-WP-V2 (PWR8IEC is simple enough to stay declarative). None of
// these consoles has documented reply text for its control commands, so two shapes are needed:
// `askConsole` waits for whatever text comes back (a command meant to print something, such as a
// status list) and `tellConsole` is fire-and-forget (a command with no documented acknowledgement,
// so waiting for one would just make every command time out).

export interface ConsoleTarget {
  host: string;
  port: number;
}

/** True when `host` is the gateway's own cloud metadata address and the device does not allow it. */
export function consoleAddressBlocked(host: string, settings: Record<string, unknown>): boolean {
  return isLinkLocal(host) && !localAddressAllowed(settings);
}

/** Sends one line and collects whatever text comes back until the console goes quiet. */
export function askConsole(
  target: ConsoleTarget,
  text: string,
  timeoutMs: number,
  deviceName: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(target);
    let reply = '';
    let done = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idle) clearTimeout(idle);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply);
    };
    const timer = setTimeout(() => finish(new Error(`${deviceName} did not respond`)), timeoutMs);
    socket.on('error', (e) => finish(new Error(`${deviceName}: ${e.message}`)));
    socket.on('connect', () => socket.write(text + '\r\n'));
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString('latin1');
      // The console holds the connection open waiting for another command, so a short quiet spell
      // counts as "done answering" rather than always waiting out the full timeout.
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish(), 200);
    });
    socket.on('close', () => finish());
  });
}

/** Sends one line and does not wait for a reply. */
export function tellConsole(
  target: ConsoleTarget,
  text: string,
  timeoutMs: number,
  deviceName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(target);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${deviceName} did not respond`));
    }, timeoutMs);
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${deviceName}: ${e.message}`));
    });
    socket.on('connect', () => {
      socket.write(text + '\r\n', (e) => {
        clearTimeout(timer);
        socket.destroy();
        if (e) reject(e);
        else resolve();
      });
    });
  });
}
