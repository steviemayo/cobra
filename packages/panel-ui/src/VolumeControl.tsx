import { useEffect, useRef } from 'react';
import { Icon } from './icons';
import type { Translate } from './i18n';

const TAP_STEP = 5;
const RAMP_STEP = 3;
const HOLD_DELAY_MS = 420;
const RAMP_INTERVAL_MS = 90;

// A button that bumps once on press, then keeps going while held.
function RampButton({
  label,
  delta,
  icon,
  onBump,
  disabled,
}: {
  label: string;
  delta: 1 | -1;
  icon: string;
  onBump: (delta: number) => void;
  disabled: boolean;
}) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ramp = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (hold.current) clearTimeout(hold.current);
    if (ramp.current) clearInterval(ramp.current);
    hold.current = null;
    ramp.current = null;
  };
  useEffect(() => stop, []);

  return (
    <button
      type="button"
      className="kp-round"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // Capture is a nicety (keeps the ramp going if the finger drifts); some browsers refuse it.
        }
        onBump(delta * TAP_STEP);
        stop();
        hold.current = setTimeout(() => {
          ramp.current = setInterval(() => onBump(delta * RAMP_STEP), RAMP_INTERVAL_MS);
        }, HOLD_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      // Keyboard users get a single step per key press.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onBump(delta * TAP_STEP);
        }
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

export function VolumeControl({
  level,
  muted,
  t,
  onBump,
  onMute,
}: {
  level: number;
  muted: boolean;
  t: Translate;
  onBump: (delta: number) => void;
  onMute: (muted: boolean) => void;
}) {
  return (
    <div className="kp-volume" role="group" aria-label={t('volume.label')}>
      <RampButton
        label={t('volume.down')}
        delta={-1}
        icon="minus"
        onBump={onBump}
        disabled={level <= 0 && !muted}
      />
      <div className="kp-volume-readout" aria-live="off">
        <span className="kp-volume-number">{muted ? '—' : Math.round(level)}</span>
        <span className="kp-volume-caption">{t('volume.label')}</span>
        <div className="kp-meter" aria-hidden>
          <div className="kp-meter-fill" style={{ width: `${muted ? 0 : Math.round(level)}%` }} />
        </div>
      </div>
      <RampButton
        label={t('volume.up')}
        delta={1}
        icon="plus"
        onBump={onBump}
        disabled={level >= 100}
      />
      <button
        type="button"
        className="kp-round kp-mute"
        aria-pressed={muted}
        aria-label={muted ? t('volume.unmute') : t('volume.mute')}
        onClick={() => onMute(!muted)}
      >
        <Icon name={muted ? 'mute' : 'volume'} />
      </button>
    </div>
  );
}
