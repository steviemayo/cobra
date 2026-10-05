import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void;

/**
 * A moment in the gateway's own time zone, as ISO 8601 with its offset ("2026-10-06T07:12:34.567+10:00"),
 * so a log reads in local time and is still unambiguous and machine readable. The zone is the
 * machine's (Windows: the system time zone; a container: its TZ setting, UTC when there is none).
 */
export function localIso(d = new Date()): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`}`
  );
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 10 * 1024 * 1024;

/**
 * One JSON object per line on stdout/stderr, so container log tooling can parse it. When `filePath`
 * is given, the same line is also appended there directly (rotating once it passes 10MB). The
 * Windows service wrapper (WinSW) redirects this process's stdout/stderr but does not reliably
 * flush them to its own log files, which otherwise leaves a Service-mode gateway with no logs at
 * all - writing the file ourselves does not depend on that.
 */
export function createLogger(min: LogLevel = 'info', filePath?: string): Logger {
  if (filePath) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // best effort - console logging below still works
    }
  }
  return (level, message, extra) => {
    if (ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify({ time: localIso(), level, message, ...extra });
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    if (!filePath) return;
    try {
      if (existsSync(filePath) && statSync(filePath).size > MAX_LOG_BYTES) {
        renameSync(filePath, `${filePath}.old`);
      }
      appendFileSync(filePath, line + '\n');
    } catch {
      // logging must never be the reason the gateway goes down
    }
  };
}

export const silentLogger: Logger = () => undefined;
