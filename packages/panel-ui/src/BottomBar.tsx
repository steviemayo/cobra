import { useState } from 'react';
import type { PanelClient, PanelQuickAction, PanelViewModel } from '@kestrel/model';
import { Clock } from './Clock';
import { Icon } from './icons';
import type { Translate } from './i18n';
import { VolumeControl } from './VolumeControl';

/** Quick actions that sit in the bar. Beyond this the rest go in the Quick Actions sheet. */
const IN_BAR = 3;

function QuickButton({
  action,
  dispatch,
  onDone,
}: {
  action: PanelQuickAction;
  dispatch: PanelClient['dispatch'];
  onDone?: () => void;
}) {
  const toggle = action.kind === 'toggle';
  return (
    <button
      type="button"
      className="kp-quick"
      aria-pressed={toggle ? action.active : undefined}
      onClick={() => {
        dispatch({
          type: 'quickaction.run',
          id: action.id,
          ...(toggle ? { active: !action.active } : {}),
        });
        onDone?.();
      }}
    >
      <Icon name={action.icon ?? 'custom'} />
      <span>{action.label}</span>
    </button>
  );
}

/**
 * Always visible: the time and room, volume, and quick actions. Volume shows only while the room is
 * on; quick actions come from the room's drivers, so a room with none shows none.
 */
export function BottomBar({
  vm,
  t,
  dispatch,
  showVolume,
}: {
  vm: PanelViewModel;
  t: Translate;
  dispatch: PanelClient['dispatch'];
  showVolume: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const actions = vm.quickActions ?? [];
  const inBar = actions.length > IN_BAR ? actions.slice(0, IN_BAR - 1) : actions;
  const rest = actions.slice(inBar.length);

  return (
    <footer className="kp-bar">
      <Clock label={vm.roomName} />

      <div className="kp-bar-mid">
        {showVolume && (
          <VolumeControl
            level={vm.volume.level}
            muted={vm.volume.muted}
            t={t}
            onBump={(delta) => dispatch({ type: 'volume.bump', delta })}
            onMute={(muted) => dispatch({ type: 'mute.set', muted })}
          />
        )}
      </div>

      <div className="kp-bar-end">
        {inBar.map((a) => (
          <QuickButton key={a.id} action={a} dispatch={dispatch} />
        ))}
        {rest.length > 0 && (
          <button type="button" className="kp-quick" onClick={() => setSheet(true)}>
            <Icon name="more" />
            <span>{t('quick.more')}</span>
          </button>
        )}
      </div>

      {sheet && (
        <div className="kp-sheet-backdrop" onClick={() => setSheet(false)}>
          <div
            className="kp-sheet"
            role="dialog"
            aria-label={t('quick.more')}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{t('quick.more')}</h2>
            <div className="kp-tiles">
              {rest.map((a) => (
                <QuickButton
                  key={a.id}
                  action={a}
                  dispatch={dispatch}
                  onDone={() => setSheet(false)}
                />
              ))}
            </div>
            <button type="button" className="kp-btn" onClick={() => setSheet(false)}>
              {t('sheet.close')}
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
