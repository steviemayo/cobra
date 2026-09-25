import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { Translate } from './i18n';

const TAP_STEP = 5;
const RAMP_STEP = 3;
const HOLD_DELAY_MS = 420;
const RAMP_INTERVAL_MS = 90;
const HUD_MS = 1500;

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

/** Volume down, mute, volume up. No slider: the level shows briefly in the VolumeHud when it changes. */
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
      <button
        type="button"
        className="kp-round kp-mute"
        aria-pressed={muted}
        aria-label={muted ? t('volume.unmute') : t('volume.mute')}
        onClick={() => onMute(!muted)}
      >
        <Icon name={muted ? 'mute' : 'volume'} />
      </button>
      <RampButton
        label={t('volume.up')}
        delta={1}
        icon="plus"
        onBump={onBump}
        disabled={level >= 100}
      />
    </div>
  );
}

/**
 * A short overlay when the level or mute changes, like a phone. With feedback it shows the 0-100
 * number; without (no device reports its level) it shows only the icon.
 */
export function VolumeHud({
  level,
  muted,
  feedback,
  t,
}: {
  level: number;
  muted: boolean;
  feedback: boolean;
  t: Translate;
}) {
  const [shown, setShown] = useState(false);
  const last = useRef<{ level: number; muted: boolean } | null>(null);

  useEffect(() => {
    const before = last.current;
    last.current = { level, muted };
    // The first value is the starting point, not a change.
    if (!before || (before.level === level && before.muted === muted)) return;
    setShown(true);
    const id = setTimeout(() => setShown(false), HUD_MS);
    return () => clearTimeout(id);
  }, [level, muted]);

  if (!shown) return null;
  const value = Math.round(level);
  return (
    <div className="kp-hud" role="status" aria-live="polite">
      <Icon name={muted ? 'mute' : 'volume'} />
      {muted ? (
        <span className="kp-hud-text">{t('volume.muted')}</span>
      ) : (
        feedback && (
          <>
            <span className="kp-hud-number">{value}</span>
            <div className="kp-hud-bar" aria-hidden>
              <div className="kp-hud-fill" style={{ width: `${value}%` }} />
            </div>
          </>
        )
      )}
    </div>
  );
}
