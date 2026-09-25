import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { LinkingSheet } from './LinkingSheet';
import { PowerDialog } from './PowerDialog';
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

/**
 * The activities as one glass pill, with a highlight that slides to the one being shown. The
 * highlight is placed by measuring the selected button, so it follows any label length or width.
 */
function ActivityNav({
  label,
  activities,
  currentId,
  onChoose,
}: {
  label: string;
  activities: PanelActivity[];
  currentId: string | undefined;
  onChoose: (a: PanelActivity) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; width: number } | null>(null);
  const [settled, setSettled] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const el = nav.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
      setAnchor(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    // Slide only after the first placement, so it does not fly in from the corner on load.
    const frame = requestAnimationFrame(() => setSettled(true));
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (nav.current) observer?.observe(nav.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [currentId, activities.length]);

  return (
    <nav className="kp-nav" aria-label={label} ref={nav}>
      {anchor && (
        <span
          className="kp-nav-anchor"
          aria-hidden
          data-settled={settled || undefined}
          style={{ width: anchor.width, transform: `translateX(${anchor.left}px)` }}
        />
      )}
      {activities.map((a) => (
        <button
          key={a.id}
          type="button"
          className="kp-nav-item"
          aria-pressed={currentId === a.id}
          data-active={a.active || undefined}
          data-kind={a.kind}
          onClick={() => onChoose(a)}
        >
          <Icon name={a.icon ?? a.kind} />
          <span>{a.name}</span>
          {a.busy && <span className="kp-spinner kp-spinner-sm" aria-hidden />}
        </button>
      ))}
    </nav>
  );
}

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
  const [confirmOff, setConfirmOff] = useState(false);
  const [linkingOpen, setLinkingOpen] = useState(false);

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

  const choose = (a: PanelActivity) => {
    setPicked(a.id);
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

  // What the room is doing, in small print under its name. "Room is off" adds nothing to the
  // start screen, so it is left out there.
  const note = vm.message && !(off && vm.message.text.key === 'room_off') ? vm.message : null;
  const brandFor = (withNote: boolean) => (
    <div className="kp-brand">
      {theme.logoUrl && <img className="kp-logo" src={theme.logoUrl} alt="" />}
      <div className="kp-brand-text">
        <h1>{vm.roomName}</h1>
        {withNote && note && (
          <p className={`kp-note kp-note-${note.tone}`} role="status" aria-live="polite">
            {note.tone === 'progress' && <span className="kp-spinner" aria-hidden />}
            {messageText(t, note.text)}
          </p>
        )}
      </div>
    </div>
  );

  // Room Off is not an activity to pick: it lives behind the Power button, with a confirmation.
  const tiles = vm.activities.filter((a) => a.kind !== 'room_off');
  const roomOff = vm.activities.find((a) => a.kind === 'room_off');
  const canPowerOff = !off && vm.status !== 'stopping' && Boolean(roomOff);

  return (
    <div
      className={`kp-app ${className ?? ''}`}
      data-mode={theme.mode}
      style={themeStyle(theme)}
      onPointerDownCapture={idleMs > 0 && !idle ? arm : undefined}
      onKeyDownCapture={idleMs > 0 && !idle ? arm : undefined}
    >
      <div className="kp-frame" inert={idle}>
        <header className={`kp-top ${off ? 'kp-top-quiet' : ''}`}>
          {brandFor(true)}

          {off ? (
            <span />
          ) : (
            <ActivityNav
              label={t('nav.label')}
              activities={tiles}
              currentId={current?.id}
              onChoose={choose}
            />
          )}

          <div className="kp-top-end">
            {headerAction}
            {vm.linking && (
              <button
                type="button"
                className="kp-power kp-link"
                onClick={() => setLinkingOpen(true)}
              >
                <Icon name="link" />
                {t('linking.button')}
              </button>
            )}
            {canPowerOff && (
              <button type="button" className="kp-power" onClick={() => setConfirmOff(true)}>
                <Icon name="power" />
                {t('power.button')}
              </button>
            )}
          </div>
        </header>

        <main className={`kp-main ${off ? 'kp-main-centre' : ''}`}>
          <PromptBar vm={vm} t={t} dispatch={dispatch} />
          <WarningBar vm={vm} t={t} dispatch={dispatch} />

          {off ? (
            <section className="kp-start">
              <h2>{t('start.title')}</h2>
              <div className="kp-tiles">
                {tiles.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="kp-tile kp-tile-big"
                    onClick={() => choose(a)}
                  >
                    <Icon name={a.icon ?? a.kind} />
                    <span>{a.name}</span>
                  </button>
                ))}
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

        {/* Nothing to control while the room is off, so no bar. */}
        {!off && (
          <>
            <BottomBar vm={vm} t={t} dispatch={dispatch} showVolume={vm.volume.available} />
            {vm.volume.available && (
              <VolumeHud
                level={vm.volume.level}
                muted={vm.volume.muted}
                feedback={vm.volume.feedback !== false}
                t={t}
              />
            )}
          </>
        )}
      </div>

      {linkingOpen && vm.linking && !idle && (
        <LinkingSheet
          linking={vm.linking}
          t={t}
          dispatch={dispatch}
          onClose={() => setLinkingOpen(false)}
        />
      )}

      {confirmOff && canPowerOff && roomOff && !idle && (
        <PowerDialog
          t={t}
          onCancel={() => setConfirmOff(false)}
          onConfirm={() => {
            setConfirmOff(false);
            choose(roomOff);
          }}
        />
      )}

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
