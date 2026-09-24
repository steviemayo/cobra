import { useState, useSyncExternalStore } from 'react';
import type { PanelActivity, PanelClient, PanelViewModel } from '@kestrel/model';
import { Icon } from './icons';
import { createTranslator, messageText, type Translate } from './i18n';
import { darkTheme, themeStyle, type PanelTheme } from './theme';
import { VolumeControl } from './VolumeControl';

export function usePanel(client: PanelClient): PanelViewModel {
  return useSyncExternalStore(
    (l) => client.subscribe(l),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
}

const TONE_ICON = { info: 'info', progress: 'info', success: 'check', warn: 'warning', error: 'warning' };

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

function PromptBar({ vm, t, dispatch }: { vm: PanelViewModel; t: Translate; dispatch: PanelClient['dispatch'] }) {
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

function WarningBar({ vm, t, dispatch }: { vm: PanelViewModel; t: Translate; dispatch: PanelClient['dispatch'] }) {
  if (!vm.warning) return null;
  return (
    <div className="kp-alert kp-alert-warn" role="alert">
      <div className="kp-alert-body">
        <strong>{messageText(t, vm.warning.text)}</strong>
        <span className="kp-muted">{t('warning.seconds', { seconds: vm.warning.secondsLeft })}</span>
      </div>
      <div className="kp-alert-actions">
        <button type="button" className="kp-btn kp-btn-primary" onClick={() => dispatch({ type: 'warning.dismiss' })}>
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

export interface PanelAppProps {
  client: PanelClient;
  theme?: PanelTheme;
  translate?: Translate;
  className?: string;
}

/**
 * The generated room panel: activities, never devices. Everything it shows comes from the client's
 * view model, so the same component serves the browser simulator and a real gateway.
 */
export function PanelApp({ client, theme = darkTheme, translate, className }: PanelAppProps) {
  const vm = usePanel(client);
  const t = translate ?? createTranslator();
  const { dispatch } = client;
  const [picked, setPicked] = useState<string | null>(null);

  const current =
    vm.activities.find((a) => a.id === picked) ??
    vm.activities.find((a) => a.active && a.kind !== 'room_off' && !a.overlay) ??
    vm.activities.find((a) => a.kind !== 'room_off' && !a.overlay) ??
    vm.activities[0];
  const off = vm.status === 'off';

  const choose = (a: PanelActivity) => {
    setPicked(a.id);
    if (a.overlay) {
      dispatch(a.active ? { type: 'activity.stop', activityId: a.id } : { type: 'activity.start', activityId: a.id });
    } else if (a.kind === 'room_off') {
      dispatch({ type: 'activity.start', activityId: a.id });
    } else if (!a.active || vm.status === 'fault') {
      dispatch({ type: 'activity.start', activityId: a.id, sourceId: defaultSource(a) });
    }
  };

  return (
    <div className={`kp-app ${className ?? ''}`} data-mode={theme.mode} style={themeStyle(theme)}>
      <header className="kp-header">
        <div className="kp-brand">
          {theme.logoUrl && <img className="kp-logo" src={theme.logoUrl} alt="" />}
          <h1>{vm.roomName}</h1>
        </div>
        <span className={`kp-pill kp-pill-${vm.status}`}>{t(`status.${vm.status}` as const)}</span>
      </header>

      <div className="kp-body">
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

        <main className="kp-main">
          <StatusBanner vm={vm} t={t} />
          <PromptBar vm={vm} t={t} dispatch={dispatch} />
          <WarningBar vm={vm} t={t} dispatch={dispatch} />

          {off ? (
            <section className="kp-start">
              <h2>{t('start.title')}</h2>
              <div className="kp-tiles">
                {vm.activities
                  .filter((a) => a.kind !== 'room_off')
                  .map((a) => (
                    <button key={a.id} type="button" className="kp-tile kp-tile-big" onClick={() => choose(a)}>
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
                          onClick={() => dispatch({ type: 'activity.start', activityId: current.id, sourceId: s.id })}
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

          {vm.volume.available && !off && (
            <VolumeControl
              level={vm.volume.level}
              muted={vm.volume.muted}
              t={t}
              onBump={(delta) => dispatch({ type: 'volume.bump', delta })}
              onMute={(muted) => dispatch({ type: 'mute.set', muted })}
            />
          )}
        </main>
      </div>
    </div>
  );
}
