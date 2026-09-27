import { useEffect, useState } from 'react';
import { scheduleView, type Meeting } from '@kestrel/model';
import type { Translate } from './i18n';

const timeFormat = () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** The current time, refreshed often enough that "on now" changes on the minute. */
function useNow(everyMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * What the room's calendar says: the meeting that is on (title, organiser, start and end) and when
 * the room is next available, or, when it is free, when the next meeting is. Nothing is drawn while
 * the bookings are not known, so a panel never shows something it cannot vouch for.
 *
 * `strip` is a slim bar for the top of the panel; `card` is the larger version on the idle screen.
 */
export function Bookings({
  meetings,
  t,
  variant,
}: {
  meetings: readonly Meeting[] | null | undefined;
  t: Translate;
  variant: 'strip' | 'card';
}) {
  const now = useNow();
  if (!meetings) return null;
  const view = scheduleView(meetings, now);
  const fmt = timeFormat();
  const { current, next, availableAt } = view;

  const title = current ? (current.private ? t('booking.private') : current.title) : '';
  const organiser =
    current && !current.private && current.organiser
      ? t('booking.organiser', { name: current.organiser })
      : '';
  const times = current
    ? t('booking.times', {
        start: fmt.format(new Date(current.start)),
        end: fmt.format(new Date(current.end)),
      })
    : '';
  const after = current
    ? availableAt && t('booking.available_at', { time: fmt.format(availableAt) })
    : next && t('booking.next_at', { time: fmt.format(new Date(next.start)) });

  return (
    <section
      className={`kp-booking kp-booking-${variant} ${current ? 'kp-booking-busy' : 'kp-booking-free'}`}
      aria-label={current ? t('booking.in_use') : t('booking.free')}
    >
      <div className="kp-booking-now">
        <span className="kp-booking-state">
          <span className="kp-booking-dot" aria-hidden />
          {current ? t('booking.in_use') : t('booking.free')}
        </span>
        {current && (
          <>
            <strong className="kp-booking-title">{title}</strong>
            {organiser && <span className="kp-booking-organiser">{organiser}</span>}
            <span className="kp-booking-times">{times}</span>
          </>
        )}
      </div>
      {after && <div className="kp-booking-after">{after}</div>}
    </section>
  );
}
