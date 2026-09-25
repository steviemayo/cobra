import { useEffect, useState } from 'react';

function parts(now: Date): { time: string; period: string } {
  const p = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(now);
  const period = p.find((x) => x.type === 'dayPeriod')?.value ?? '';
  const time = p
    .filter((x) => x.type !== 'dayPeriod')
    .map((x) => x.value)
    .join('')
    .trim();
  return { time, period };
}

/** The time in the panel's local format, updated every few seconds. */
export function Clock({ label }: { label: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5000);
    return () => clearInterval(id);
  }, []);
  const { time, period } = parts(now);
  return (
    <div className="kp-clock">
      <span className="kp-clock-time">
        {time}
        {period && <span className="kp-clock-period">{period}</span>}
      </span>
      <span className="kp-clock-label">{label}</span>
    </div>
  );
}
