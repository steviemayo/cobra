export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line on stdout/stderr, so container log tooling can parse it. */
export function createLogger(min: LogLevel = 'info'): Logger {
  return (level, message, extra) => {
    if (ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...extra });
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
}

export const silentLogger: Logger = () => undefined;
