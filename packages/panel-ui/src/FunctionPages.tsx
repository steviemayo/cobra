import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  DisplayKey,
  MoverAction,
  PanelCamera,
  PanelClient,
  PanelDisplay,
  PanelFunctions,
  PanelLight,
  PanelMic,
  PanelMover,
} from '@kestrel/model';
import { Icon } from './icons';
import type { TextKey, Translate } from './i18n';

/** How often a held button repeats its move. The room stops the camera if the repeats stop. */
const REPEAT_MS = 500;

export type PageId = 'cameras' | 'microphones' | 'controls' | 'display';

/** The pages this room offers behind the top nav. */
export function functionPages(f: PanelFunctions | undefined): PageId[] {
  if (!f) return [];
  const pages: PageId[] = [];
  if (f.cameras.length > 0) pages.push('cameras');
  if (f.microphones.length > 0) pages.push('microphones');
  if (f.lights.length > 0 || f.movers.length > 0) pages.push('controls');
  if ((f.displays ?? []).length > 0) pages.push('display');
  return pages;
}

export const PAGE_ICON: Record<PageId, string> = {
  cameras: 'camera',
  microphones: 'mic',
  controls: 'controls',
  display: 'present',
};

type Dispatch = PanelClient['dispatch'];

/**
 * A button that acts for as long as it is held: it starts when pressed, repeats while held, and
 * ends when released, dragged off, or interrupted. Used for pointing a camera.
 */
function HoldButton({
  label,
  icon,
  onHold,
  onEnd,
}: {
  label: string;
  icon: string;
  onHold: () => void;
  onEnd: () => void;
}) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holding = useRef(false);
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const end = () => {
    if (!holding.current) return;
    holding.current = false;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    ended.current();
  };
  const endRef = useRef(end);
  endRef.current = end;
  // Leaving the page while held must not leave the camera running.
  useEffect(() => () => endRef.current(), []);
  return (
    <button
      type="button"
      className="kp-hold"
      aria-label={label}
      title={label}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        holding.current = true;
        onHold();
        timer.current = setInterval(onHold, REPEAT_MS);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
      onLostPointerCapture={end}
    >
      <Icon name={icon} />
    </button>
  );
}

function CameraCard({
  camera,
  t,
  dispatch,
}: {
  camera: PanelCamera;
  t: Translate;
  dispatch: Dispatch;
}) {
  const move = (pan: number, tilt: number, zoom: number) => () =>
    dispatch({ type: 'camera.move', deviceId: camera.id, pan, tilt, zoom });
  const stop = move(0, 0, 0);
  const pad = (label: TextKey, icon: string, pan: number, tilt: number, zoom = 0) => (
    <HoldButton label={t(label)} icon={icon} onHold={move(pan, tilt, zoom)} onEnd={stop} />
  );
  return (
    <section className="kp-fn-card" aria-label={camera.name}>
      <h3>{camera.name}</h3>
      {camera.presets.length > 0 && (
        <>
          <p className="kp-muted">{t('fn.presets')}</p>
          <div className="kp-tiles">
            {camera.presets.map((p) => (
              <button
                key={p}
                type="button"
                className="kp-tile"
                aria-pressed={camera.activePreset === p}
                onClick={() => dispatch({ type: 'camera.preset', deviceId: camera.id, preset: p })}
              >
                <span className="kp-tile-title">{p}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {camera.canMove && (
        <>
          <p className="kp-muted">{t('fn.move')}</p>
          <div className="kp-pad" role="group" aria-label={t('fn.move')}>
            <span />
            {pad('cam.up', 'arrow-up', 0, 1)}
            <span />
            {pad('cam.left', 'arrow-left', -1, 0)}
            <span className="kp-pad-mid" aria-hidden>
              <Icon name="camera" />
            </span>
            {pad('cam.right', 'arrow-right', 1, 0)}
            {pad('cam.zoom_out', 'minus', 0, 0, -1)}
            {pad('cam.down', 'arrow-down', 0, -1)}
            {pad('cam.zoom_in', 'plus', 0, 0, 1)}
          </div>
        </>
      )}
    </section>
  );
}

const KEY_ICON: Partial<Record<DisplayKey, string>> = {
  up: 'arrow-up',
  down: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
};
const KEY_LABEL: Record<DisplayKey, TextKey> = {
  up: 'cam.up',
  down: 'cam.down',
  left: 'cam.left',
  right: 'cam.right',
  ok: 'key.ok',
  back: 'key.back',
  home: 'key.home',
  menu: 'key.menu',
  play: 'key.play',
  pause: 'key.pause',
  stop: 'key.stop',
  forward: 'key.forward',
  rewind: 'key.rewind',
};

function DisplayCard({
  display,
  showName,
  t,
  dispatch,
}: {
  display: PanelDisplay;
  /** More than one display: say which one this is. */
  showName: boolean;
  t: Translate;
  dispatch: Dispatch;
}) {
  const press = (key: DisplayKey) => () => dispatch({ type: 'display.key', deviceId: display.id, key });
  const tap = (key: DisplayKey) => (
    <button key={key} type="button" className="kp-tile" onClick={press(key)}>
      <span className="kp-tile-title">{t(KEY_LABEL[key])}</span>
    </button>
  );
  const arrow = (key: DisplayKey) => (
    <HoldButton key={key} label={t(KEY_LABEL[key])} icon={KEY_ICON[key]!} onHold={press(key)} onEnd={() => undefined} />
  );
  return (
    <section className="kp-fn-card" aria-label={display.name}>
      {showName && <h3>{display.name}</h3>}
      {display.apps.length > 0 && (
        <>
          <p className="kp-muted">{t('display.apps')}</p>
          <div className="kp-tiles">
            {display.apps.map((a) => (
              <button
                key={a.id}
                type="button"
                className="kp-tile"
                aria-pressed={display.activeApp === a.id}
                onClick={() => dispatch({ type: 'display.app', deviceId: display.id, appId: a.id })}
              >
                <span className="kp-tile-title">{a.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {display.keys && (
        <>
          <p className="kp-muted">{t('display.keys')}</p>
          <div className="kp-pad" role="group" aria-label={t('display.keys')}>
            <span />
            {arrow('up')}
            <span />
            {arrow('left')}
            {tap('ok')}
            {arrow('right')}
            {tap('back')}
            {arrow('down')}
            {tap('home')}
          </div>
          <div className="kp-tiles">{tap('menu')}</div>
        </>
      )}
      {display.media && (
        <>
          <p className="kp-muted">{t('display.media')}</p>
          <div className="kp-tiles">{(['rewind', 'play', 'pause', 'stop', 'forward'] as DisplayKey[]).map(tap)}</div>
        </>
      )}
    </section>
  );
}

function MicRow({ mic, t, dispatch }: { mic: PanelMic; t: Translate; dispatch: Dispatch }) {
  const muted = mic.muted === true;
  return (
    <button
      type="button"
      className="kp-tile kp-tile-wide"
      aria-pressed={muted}
      onClick={() => dispatch({ type: 'mic.mute', deviceId: mic.id, muted: !muted })}
    >
      <Icon name={muted ? 'mic-off' : 'mic'} />
      <span className="kp-tile-title">{mic.name}</span>
      {mic.muted !== null && (
        <span className="kp-tile-note">{muted ? t('mic.muted') : t('mic.live')}</span>
      )}
    </button>
  );
}

function LightCard({ light, dispatch }: { light: PanelLight; dispatch: Dispatch }) {
  return (
    <section className="kp-fn-card" aria-label={light.name}>
      <h3>{light.name}</h3>
      <div className="kp-tiles">
        {light.scenes.map((s) => (
          <button
            key={s}
            type="button"
            className="kp-tile"
            aria-pressed={light.active === s}
            onClick={() => dispatch({ type: 'scene.set', deviceId: light.id, scene: s })}
          >
            <span className="kp-tile-title">{s}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const MOVER_LABEL: Record<MoverAction, TextKey> = {
  open: 'mover.open',
  close: 'mover.close',
  up: 'mover.up',
  down: 'mover.down',
};

function MoverCard({
  mover,
  t,
  dispatch,
}: {
  mover: PanelMover;
  t: Translate;
  dispatch: Dispatch;
}) {
  return (
    <section className="kp-fn-card" aria-label={mover.name}>
      <h3>{mover.name}</h3>
      <div className="kp-tiles">
        {mover.actions.map((a) => (
          <button
            key={a}
            type="button"
            className="kp-tile"
            onClick={() => dispatch({ type: 'mover.run', deviceId: mover.id, action: a })}
          >
            <span className="kp-tile-title">{t(MOVER_LABEL[a])}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** One of the pages behind the top nav. */
export function FunctionPage({
  page,
  functions,
  t,
  dispatch,
}: {
  page: PageId;
  functions: PanelFunctions;
  t: Translate;
  dispatch: Dispatch;
}) {
  if (page === 'cameras')
    return (
      <section className="kp-activity" aria-label={t('fn.cameras')}>
        <h2>{t('fn.cameras')}</h2>
        {functions.cameras.map((c) => (
          <CameraCard key={c.id} camera={c} t={t} dispatch={dispatch} />
        ))}
      </section>
    );
  if (page === 'microphones')
    return (
      <section className="kp-activity" aria-label={t('fn.microphones')}>
        <h2>{t('fn.microphones')}</h2>
        <div className="kp-tiles">
          {functions.microphones.map((m) => (
            <MicRow key={m.id} mic={m} t={t} dispatch={dispatch} />
          ))}
        </div>
      </section>
    );
  if (page === 'display')
    return (
      <section className="kp-activity" aria-label={t('fn.display')}>
        <h2>{t('fn.display')}</h2>
        {(functions.displays ?? []).map((d) => (
          <DisplayCard key={d.id} display={d} showName={(functions.displays ?? []).length > 1} t={t} dispatch={dispatch} />
        ))}
      </section>
    );
  return (
    <section className="kp-activity" aria-label={t('fn.controls')}>
      <h2>{t('fn.controls')}</h2>
      {functions.lights.length > 0 && <p className="kp-muted">{t('controls.lights')}</p>}
      {functions.lights.map((l) => (
        <LightCard key={l.id} light={l} dispatch={dispatch} />
      ))}
      {functions.movers.length > 0 && <p className="kp-muted">{t('controls.blinds')}</p>}
      {functions.movers.map((m) => (
        <MoverCard key={m.id} mover={m} t={t} dispatch={dispatch} />
      ))}
    </section>
  );
}
