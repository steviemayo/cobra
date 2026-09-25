import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  PanelSettings,
  type PanelActivity,
  type PanelClient,
  type PanelViewModel,
} from '@kestrel/model';
import { BottomBar } from './BottomBar';
import { IdleScreen } from './IdleScreen';
import { Icon } from './icons';
import { messageText, type Translate } from './i18n';
import { translatorFor } from './languages';
import { darkTheme, themeStyle, type PanelTheme } from './theme';
import { VolumeHud } from './VolumeControl';

export function usePanel(client: PanelClient): PanelViewModel {
  return useSyncExternalStore(
    (l) => client.subscribe(l),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
}

const TONE_ICON = {
  info: 'info',
  progress: 'info',
  success: 'check',
  warn: 'warning',
  error: 'warning',
};

function CombineBar({
  vm,
  t,
  dispatch,
}: {
  vm: PanelViewModel;
  t: Translate;
  dispatch: PanelClient['dispatch'];
}) {
  const c = vm.combination;
  if (c?.role !== 'primary') return null;
  const rooms = c.rooms.join(', ');
  return (
    <div className="kp-banner kp-tone-info" role="group">
      <span>{c.combined ? t('combine.status', { rooms }) : t('combine.join', { rooms })}</span>
      <button
        type="button"
        className="kp-btn"
        onClick={() => dispatch({ type: 'combine.set', combined: !c.combined })}
      >
        {c.combined ? t('combine.split') : t('combine.join', { rooms })}
      </button>
    </div>
  );
}

function StatusBanner({ vm, t }: { vm: PanelViewModel; t: Translate }) {
  if (!vm.message) return null;
  const { text, tone } = vm.message;
  return (
    <div className={`kp-banner kp-tone-${tone}`} role="status" aria-live="polite">
      {tone === 'progress' ? (
        <span className="kp-spinner" aria-hidden />
      ) : (
        <Icon name={TONE_ICON[tone]} />
      )}
      <span>{messageText(t, text)}</span>
    </div>
  );
}

function PromptBar({
  vm,
  t,
  dispatch,
}: {
  vm: PanelViewModel;
  t: Translate;
  dispatch: PanelClient['dispatch'];
}) {
  if (!vm.prompt) return null;
  const { prompt } = vm;
  return (
    <div className="kp-alert" role="alertdialog" aria-label={messageText(t, prompt.text)}>
      <div className="kp-alert-body">
        <strong>{messageText(t, prompt.text)}</strong>
        {prompt.secondsLeft !== null && (
          <span className="kp-muted">{t('prompt.seconds', { seconds: prompt.secondsLeft })}</span>
        )}
      </div>
      <div className="kp-alert-actions">
        <button
          type="button"
          className="kp-btn kp-btn-primary"
          onClick={() => dispatch({ type: 'prompt.respond', promptId: prompt.id, accept: true })}
        >
          {t('prompt.accept')}
        </button>
        <button
          type="button"
          className="kp-btn"
          onClick={() => dispatch({ type: 'prompt.respond', promptId: prompt.id, accept: false })}
        >
          {t('prompt.decline')}
        </button>
      </div>
    </div>
  );
}

function WarningBar({
  vm,
  t,
  dispatch,
}: {
  vm: PanelViewModel;
  t: Translate;
  dispatch: PanelClient['dispatch'];
}) {
  if (!vm.warning) return null;
  return (
    <div className="kp-alert kp-alert-warn" role="alert">
      <div className="kp-alert-body">
        <strong>{messageText(t, vm.warning.text)}</strong>
        <span className="kp-muted">
          {t('warning.seconds', { seconds: vm.warning.secondsLeft })}
        </span>
      </div>
      <div className="kp-alert-actions">
        <button
          type="button"
          className="kp-btn kp-btn-primary"
          onClick={() => dispatch({ type: 'warning.dismiss' })}
        >
          {t('warning.stay')}
        </button>
      </div>
    </div>
  );
}

function defaultSource(a: PanelActivity): string | undefined {
  return (
    a.sources.find((s) => s.selected)?.id ??
    a.sources.find((s) => s.present === true)?.id ??
    a.sources[0]?.id
  );
}

const DEFAULT_UI = PanelSettings.parse({});

export interface PanelAppProps {
  client: PanelClient;
  theme?: PanelTheme;
  translate?: Translate;
  /** A language code such as "es". Ignored if `translate` is given. */
  language?: string;
  className?: string;
  /** An extra control for the top bar, e.g. the phone-control button. */
  headerAction?: ReactNode;
}

/**
 * The generated room panel: activities, never devices. Everything it shows comes from the client's
 * view model, so the same component serves the browser simulator and a real gateway.
 *
 * Layout: top bar (room, navigation), content, and an always-visible bottom bar (time, volume,
 * quick actions). Home is a grid of activities or, per room setting, the running activity with a
 * top nav. An optional "Touch to begin" screen covers everything after a period without touches.
 */
export function PanelApp({
  client,
  theme = darkTheme,
  translate,
  language,
  className,
  headerAction,
}: PanelAppProps) {
  const vm = usePanel(client);
  const t = translate ?? translatorFor(language);
  const dispatch: PanelClient['dispatch'] = (intent) => client.dispatch(intent);
  const ui = vm.ui ?? DEFAULT_UI;
  const [picked, setPicked] = useState<string | null>(null);
  const [home, setHome] = useState(false);

  // "Touch to begin": shown on load and again after `timeoutMinutes` without a touch (0 = never).
  const idleMs = ui.idle.timeoutMinutes * 60_000;
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const configured = useRef(false);
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    if (idleMs > 0) timer.current = setTimeout(() => setIdle(true), idleMs);
  }, [idleMs]);
  useEffect(() => {
    if (idleMs === 0) {
      clearTimeout(timer.current);
      configured.current = false;
      setIdle(false);
      return;
    }
    if (!configured.current) {
      configured.current = true;
      setIdle(true);
    } else arm();
    return () => clearTimeout(timer.current);
  }, [idleMs, arm]);
  // A question or the auto-off countdown must never sit behind the idle screen.
  const attention = Boolean(vm.prompt || vm.warning);
  useEffect(() => {
    if (!attention) return;
    setIdle(false);
    arm();
  }, [attention, arm]);

  const current =
    vm.activities.find((a) => a.id === picked) ??
    vm.activities.find((a) => a.active && a.kind !== 'room_off' && !a.overlay) ??
    vm.activities.find((a) => a.kind !== 'room_off' && !a.overlay) ??
    vm.activities[0];
  const off = vm.status === 'off';
  const following = vm.combination?.role === 'secondary' && vm.combination.combined;
  const navMode = ui.homeMode === 'nav';

  const choose = (a: PanelActivity) => {
    setPicked(a.id);
    setHome(false);
    if (a.overlay) {
      dispatch(
        a.active
          ? { type: 'activity.stop', activityId: a.id }
          : { type: 'activity.start', activityId: a.id },
      );
    } else if (a.kind === 'room_off') {
      dispatch({ type: 'activity.start', activityId: a.id });
    } else if (!a.active || vm.status === 'fault') {
      dispatch({ type: 'activity.start', activityId: a.id, sourceId: defaultSource(a) });
    }
  };

  const wake = () => {
    setIdle(false);
    arm();
    if (!off) return;
    if (ui.idle.action === 'on') dispatch({ type: 'room.on' });
    else if (ui.idle.action === 'activity') {
      const a =
        vm.activities.find((x) => x.id === ui.idle.activityId) ??
        vm.activities.find((x) => x.kind !== 'room_off' && !x.overlay);
      if (a) choose(a);
    }
  };

  const brand = (
    <div className="kp-brand">
      {theme.logoUrl && <img className="kp-logo" src={theme.logoUrl} alt="" />}
      <h1>{vm.roomName}</h1>
    </div>
  );

  if (following)
    return (
      <div className={`kp-app ${className ?? ''}`} data-mode={theme.mode} style={themeStyle(theme)}>
        <div className="kp-frame">
          <header className="kp-top">{brand}</header>
          <main className="kp-main">
            <StatusBanner vm={vm} t={t} />
          </main>
        </div>
      </div>
    );

  const showTiles = off || (!navMode && home);
  const tiles = vm.activities.filter((a) => a.kind !== 'room_off');
  const roomOff = vm.activities.find((a) => a.kind === 'room_off');
  const showVolume = vm.volume.available && !off;

  return (
    <div
      className={`kp-app ${className ?? ''}`}
      data-mode={theme.mode}
      style={themeStyle(theme)}
      onPointerDownCapture={idleMs > 0 && !idle ? arm : undefined}
      onKeyDownCapture={idleMs > 0 && !idle ? arm : undefined}
    >
      <div className="kp-frame" inert={idle}>
        <header className="kp-top">
          {brand}

          {navMode && !off ? (
            <nav className="kp-nav" aria-label={t('nav.label')}>
              {vm.activities.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="kp-nav-item"
                  aria-pressed={current?.id === a.id}
                  data-active={a.active || undefined}
                  data-kind={a.kind}
                  onClick={() => choose(a)}
                >
                  <Icon name={a.icon ?? a.kind} />
                  <span>{a.name}</span>
                  {a.busy && <span className="kp-spinner kp-spinner-sm" aria-hidden />}
                </button>
              ))}
            </nav>
          ) : (
            <span />
          )}

          <div className="kp-top-end">
            {!navMode && !off && (
              <button
                type="button"
                className="kp-btn kp-home"
                aria-pressed={home}
                onClick={() => setHome((h) => !h)}
              >
                <Icon name="home" />
                {t('nav.home')}
              </button>
            )}
            <span className={`kp-pill kp-pill-${vm.status}`}>
              {t(`status.${vm.status}` as const)}
            </span>
            {headerAction}
          </div>
        </header>

        <main className="kp-main">
          <StatusBanner vm={vm} t={t} />
          <CombineBar vm={vm} t={t} dispatch={dispatch} />
          <PromptBar vm={vm} t={t} dispatch={dispatch} />
          <WarningBar vm={vm} t={t} dispatch={dispatch} />

          {showTiles ? (
            <section className="kp-start">
              <h2>{off ? t('start.title') : t('home.title')}</h2>
              <div className="kp-tiles">
                {tiles.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="kp-tile kp-tile-big"
                    aria-pressed={!off && a.active}
                    onClick={() => choose(a)}
                  >
                    <Icon name={a.icon ?? a.kind} />
                    <span>{a.name}</span>
                  </button>
                ))}
                {!off && roomOff && (
                  <button
                    type="button"
                    className="kp-tile kp-tile-big kp-tile-quiet"
                    onClick={() => choose(roomOff)}
                  >
                    <Icon name={roomOff.icon ?? roomOff.kind} />
                    <span>{roomOff.name}</span>
                  </button>
                )}
              </div>
            </section>
          ) : (
            current && (
              <section className="kp-activity" aria-label={current.name}>
                <h2>{current.name}</h2>
                {current.overlay ? (
                  <button
                    type="button"
                    className={`kp-btn kp-btn-big ${current.active ? 'kp-btn-danger' : 'kp-btn-primary'}`}
                    disabled={current.busy}
                    onClick={() => choose(current)}
                  >
                    <Icon name="record" />
                    {current.active ? t('record.stop') : t('record.start')}
                  </button>
                ) : current.sources.length > 0 ? (
                  <>
                    <p className="kp-muted">{t('sources.title')}</p>
                    <div className="kp-tiles">
                      {current.sources.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className="kp-tile"
                          aria-pressed={s.selected}
                          onClick={() =>
                            dispatch({
                              type: 'activity.start',
                              activityId: current.id,
                              sourceId: s.id,
                            })
                          }
                        >
                          <span className="kp-tile-title">{s.label}</span>
                          {s.present !== null && (
                            <span className={`kp-tile-note ${s.present ? 'kp-ok' : ''}`}>
                              <Icon name={s.present ? 'check' : 'plug'} />
                              {s.present ? t('source.connected') : t('source.disconnected')}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="kp-muted">{t('activity.running')}</p>
                )}
              </section>
            )
          )}
        </main>

        <BottomBar vm={vm} t={t} dispatch={dispatch} showVolume={showVolume} />
        {showVolume && (
          <VolumeHud
            level={vm.volume.level}
            muted={vm.volume.muted}
            feedback={vm.volume.feedback !== false}
            t={t}
          />
        )}
      </div>

      {idle && (
        <IdleScreen
          roomName={vm.roomName}
          logoUrl={theme.logoUrl}
          supportText={ui.idle.supportText}
          supportUrl={ui.idle.supportUrl}
          t={t}
          onWake={wake}
        />
      )}
    </div>
  );
}
