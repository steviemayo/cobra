import { useState, useSyncExternalStore } from 'react';
import { PanelApp } from './PanelApp';
import { Icon } from './icons';
import { QrCode } from './QrCode';
import type { Translate } from './i18n';
import { translatorFor } from './languages';
import { themeFromBranding } from './theme';
import { themeStyle } from './theme';
import type { WsPanelClient } from './ws-client';

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

function PinGate({
  onSubmit,
  message,
  t,
}: {
  onSubmit: (pin: string) => void;
  message?: string;
  t: Translate;
}) {
  const [pin, setPin] = useState('');
  const add = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));
  return (
    <section
      className="kp-pin"
      onKeyDown={(e) => {
        if (/^\d$/.test(e.key)) add(e.key);
        else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
        else if (e.key === 'Enter' && pin) {
          onSubmit(pin);
          setPin('');
        }
      }}
    >
      <h2>{t('pin.title')}</h2>
      <div className="kp-pin-dots" aria-label={t('pin.title')} role="status">
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? 'kp-dot kp-dot-on' : 'kp-dot'} />
        ))}
      </div>
      {message && (
        <p className="kp-pin-error" role="alert">
          {message}
        </p>
      )}
      <div className="kp-keypad">
        {PIN_KEYS.map((k) => (
          <button key={k} type="button" className="kp-key" onClick={() => add(k)}>
            {k}
          </button>
        ))}
        <button type="button" className="kp-key kp-key-quiet" onClick={() => setPin('')}>
          {t('pin.clear')}
        </button>
        <button type="button" className="kp-key" onClick={() => add('0')}>
          0
        </button>
        <button
          type="button"
          className="kp-key kp-key-primary"
          disabled={!pin}
          aria-label={t('pin.submit')}
          onClick={() => {
            onSubmit(pin);
            setPin('');
          }}
        >
          <Icon name="check" />
        </button>
      </div>
    </section>
  );
}

/**
 * Wraps the panel with everything a real screen on the wall needs: connecting, the PIN gate,
 * and a non-blocking "reconnecting" bar so a gateway restart never leaves a blank screen.
 */
export function PanelSession({
  client,
  translate,
  className,
}: {
  client: WsPanelClient;
  translate?: Translate;
  className?: string;
}) {
  const conn = useSyncExternalStore(
    client.subscribeConnection,
    client.getConnection,
    client.getConnection,
  );
  const t = translate ?? translatorFor(conn.branding?.language);
  const theme = themeFromBranding(conn.branding);
  const [showQr, setShowQr] = useState(false);

  if (conn.state === 'pin_required' || conn.state === 'connecting' || conn.state === 'error')
    return (
      <div
        className={`kp-app kp-center ${className ?? ''}`}
        data-mode={theme.mode}
        style={themeStyle(theme)}
      >
        {conn.state === 'pin_required' ? (
          <PinGate onSubmit={(pin) => client.submitPin(pin)} message={conn.message} t={t} />
        ) : (
          <div className="kp-splash" role="status">
            {conn.state === 'connecting' && <span className="kp-spinner" aria-hidden />}
            <p>
              {conn.state === 'error'
                ? (conn.message ?? t('session.error'))
                : t('session.connecting')}
            </p>
          </div>
        )}
      </div>
    );

  const phoneButton = conn.qr ? (
    <button
      type="button"
      className="kp-phone-btn"
      aria-label={t('phone.button')}
      title={t('phone.button')}
      onClick={() => setShowQr(true)}
    >
      <Icon name="phone" />
    </button>
  ) : undefined;

  return (
    <>
      <PanelApp
        client={client}
        theme={theme}
        translate={t}
        className={className}
        headerAction={phoneButton}
      />
      {conn.qr && showQr && (
        <div data-mode={theme.mode} style={themeStyle(theme)}>
          <div
            className="kp-modal"
            role="dialog"
            aria-label={t('phone.button')}
            onClick={() => setShowQr(false)}
          >
            <div className="kp-modal-card" onClick={(e) => e.stopPropagation()}>
              <h2>{t('phone.button')}</h2>
              <QrCode value={conn.qr.url} label={t('phone.title')} />
              <p className="kp-muted">{t('phone.title')}</p>
              <button
                type="button"
                className="kp-btn kp-btn-primary"
                onClick={() => setShowQr(false)}
              >
                {t('phone.close')}
              </button>
            </div>
          </div>
        </div>
      )}
      {conn.state === 'reconnecting' && (
        <div className="kp-offline" role="status" data-mode={theme.mode} style={themeStyle(theme)}>
          <span className="kp-spinner kp-spinner-sm" aria-hidden />
          {t('session.reconnecting')}
        </div>
      )}
    </>
  );
}
