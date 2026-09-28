import net from 'node:net';
import tls from 'node:tls';

// The Crestron secure console (SCTP) of a Flex UC-Engine (Microsoft Teams Room), TLS on port
// 41797: send a blank line to get `Login:`, then the user name, then `Password:` and the password,
// and commands run at the `UC-ENGINE>` prompt. Verified against a real unit. Reserved joins are
// read with `showdigital`/`showserial`/`showanalog <join>`, which answer
// "Digital Join 27767, Value 0".

export const CONSOLE_PROMPT = 'UC-ENGINE>';
const LOGIN_PROMPT = 'Login:';
const PASSWORD_PROMPT = 'Password:';

export interface ConsoleOptions {
  port: number;
  username: string;
  password: string;
  /** TLS (the unit's own self-signed certificate is accepted). Plain only for tests. */
  secure: boolean;
  timeoutMs: number;
}

export class ConsoleError extends Error {
  constructor(
    message: string,
    /** A refused login won't get better by asking again. */
    readonly permanent = false,
  ) {
    super(message);
  }
}

/** One console session: opens and logs in on first use, runs one command at a time. */
export class CrestronConsole {
  private sock: net.Socket | null = null;
  private buf = '';
  private waiting: ((closed: boolean) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: string,
    private readonly o: ConsoleOptions,
  ) {}

  close() {
    this.sock?.destroy();
    this.sock = null;
  }

  /** Runs a command and returns what it printed, without the echo or the prompt. */
  run(command: string): Promise<string> {
    const next = this.queue.then(() => this.exec(command));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async exec(command: string): Promise<string> {
    try {
      if (!this.sock) await this.open();
      this.sock!.write(command + '\r\n');
      const raw = await this.expect([CONSOLE_PROMPT]);
      return raw.replace(command, '').replace(CONSOLE_PROMPT, '').trim();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private async open() {
    this.buf = '';
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = this.o.secure
        ? tls.connect({ host: this.host, port: this.o.port, rejectUnauthorized: false }, () =>
            resolve(s),
          )
        : net.connect({ host: this.host, port: this.o.port }, () => resolve(s));
      s.setTimeout(this.o.timeoutMs);
      s.once('error', reject);
      s.once('timeout', () => s.destroy(new Error('timed out connecting')));
    });
    sock.setTimeout(0);
    sock.on('data', (c: Buffer) => {
      this.buf += c.toString('utf8');
      this.waiting?.(false);
    });
    const gone = () => {
      if (this.sock === sock) this.sock = null;
      this.waiting?.(true);
    };
    sock.on('error', gone);
    sock.on('close', gone);
    this.sock = sock;

    sock.write('\r\n');
    await this.expect([LOGIN_PROMPT]);
    sock.write(this.o.username + '\r\n');
    await this.expect([PASSWORD_PROMPT]);
    sock.write(this.o.password + '\r\n');
    const after = await this.expect([CONSOLE_PROMPT, LOGIN_PROMPT]);
    if (!after.includes(CONSOLE_PROMPT))
      throw new ConsoleError('login refused: check the user name and password', true);
  }

  /** Waits until one of the needles has arrived; returns everything up to and including it. */
  private expect(needles: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new ConsoleError(`no ${needles[0]} from the unit`));
      }, this.o.timeoutMs);
      const check = (closed: boolean) => {
        const hit = needles
          .map((n) => ({ n, at: this.buf.indexOf(n) }))
          .filter((x) => x.at >= 0)
          .sort((a, b) => a.at - b.at)[0];
        if (hit) {
          clearTimeout(timer);
          this.waiting = null;
          const end = hit.at + hit.n.length;
          const out = this.buf.slice(0, end);
          this.buf = this.buf.slice(end);
          resolve(out);
        } else if (closed) {
          clearTimeout(timer);
          this.waiting = null;
          reject(new ConsoleError('the unit closed the connection'));
        }
      };
      this.waiting = check;
      check(false);
    });
  }
}

export type JoinKind = 'digital' | 'serial' | 'analog';

/** "D27767", "serial 27702", "a17347": a reserved join to read. */
export function parseJoinAddress(address: string): { kind: JoinKind; join: number } | undefined {
  const m = /^\s*(d|digital|s|serial|a|analog)\s*[ :]?\s*(\d{1,5})\s*$/i.exec(address);
  if (!m) return undefined;
  const k = m[1]!.toLowerCase();
  return {
    kind: k[0] === 'd' ? 'digital' : k[0] === 's' ? 'serial' : 'analog',
    join: Number(m[2]),
  };
}

/** The value out of "Digital Join 27767, Value 0". */
export function parseJoinValue(
  kind: JoinKind,
  reply: string,
): boolean | number | string | undefined {
  const m = /Value\s+(.*)$/im.exec(reply);
  if (!m) return undefined;
  const raw = m[1]!.trim();
  if (kind === 'digital') return raw === '1' ? true : raw === '0' ? false : undefined;
  if (kind === 'analog') return /^-?\d+$/.test(raw) ? Number(raw) : undefined;
  return raw;
}
