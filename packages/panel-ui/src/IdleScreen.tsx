import type { Meeting } from '@kestrel/model';
import { Bookings } from './Bookings';
import { Clock } from './Clock';
import { Icon } from './icons';
import type { Translate } from './i18n';
import { QrCode } from './QrCode';

/** "Touch to begin". Any touch wakes the panel; the room's settings decide what else happens. */
export function IdleScreen({
  roomName,
  logoUrl,
  supportText,
  supportUrl,
  schedule,
  t,
  onWake,
}: {
  roomName: string;
  logoUrl?: string;
  supportText?: string;
  supportUrl?: string;
  schedule?: readonly Meeting[] | null;
  t: Translate;
  onWake: () => void;
}) {
  return (
    <button type="button" className="kp-idle" aria-label={t('idle.begin')} onClick={onWake}>
      <div className="kp-idle-center">
        {logoUrl && <img className="kp-idle-logo" src={logoUrl} alt="" />}
        <Bookings meetings={schedule} t={t} variant="card" />
        <span className="kp-idle-ring">
          <Icon name="touch" />
        </span>
        <span className="kp-idle-title">{t('idle.begin')}</span>
      </div>
      <div className="kp-idle-foot">
        <Clock label={roomName} />
        {(supportText || supportUrl) && (
          <div className="kp-idle-support">
            <div>
              <strong>{t('idle.support')}</strong>
              {supportText && <p>{supportText}</p>}
            </div>
            {supportUrl && <QrCode value={supportUrl} label={t('idle.support')} />}
          </div>
        )}
      </div>
    </button>
  );
}
