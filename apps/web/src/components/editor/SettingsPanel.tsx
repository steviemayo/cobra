'use client';
import { PanelSettings, type IdleAction } from '@kestrel/model';
import { Label, inputCls, type PanelProps } from './ui';

function NumberField({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      className={`${inputCls} w-24`}
      value={value}
      onChange={(e) =>
        onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || 0))))
      }
    />
  );
}

const IDLE_ACTIONS = [
  { value: 'wake', label: 'Just open the panel' },
  { value: 'activity', label: 'Start an activity' },
  { value: 'on', label: 'Turn the room on' },
] as const;

function PanelSection({ model, update }: PanelProps) {
  // Drafts saved before these settings existed have no `panel`; treat that as the defaults.
  const panel = model.settings.panel ?? PanelSettings.parse({});
  const idle = panel.idle;
  const change = (fn: (p: PanelSettings) => void) =>
    update((m) => {
      m.settings.panel ??= PanelSettings.parse({});
      fn(m.settings.panel);
    });
  const startable = model.activities.filter((a) => a.kind !== 'room_off');

  return (
    <div className="space-y-4 border-t pt-5">
      <div>
        <h3 className="text-sm font-medium">Touch panel</h3>
        <p className="text-xs text-muted-foreground">
          How the panel looks and behaves in this room.
        </p>
      </div>
      <Label text={'When someone touches "Touch to begin"'}>
        <select
          className={inputCls}
          value={idle.action}
          onChange={(e) => change((p) => void (p.idle.action = e.target.value as IdleAction))}
        >
          {IDLE_ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </Label>
      {idle.action === 'activity' && (
        <Label text="Activity to start">
          <select
            className={inputCls}
            value={idle.activityId ?? ''}
            onChange={(e) => change((p) => void (p.idle.activityId = e.target.value || undefined))}
          >
            <option value="">First activity</option>
            {startable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Label>
      )}
      <Label text="Minutes without a touch before showing “Touch to begin” (0 = never)">
        <NumberField
          value={idle.timeoutMinutes}
          min={0}
          max={240}
          onChange={(v) => change((p) => void (p.idle.timeoutMinutes = v))}
        />
      </Label>
      <Label text="Support text on that screen">
        <input
          className={`${inputCls} w-full`}
          maxLength={200}
          value={idle.supportText ?? ''}
          placeholder="Need help? Dial 1234"
          onChange={(e) => change((p) => void (p.idle.supportText = e.target.value || undefined))}
        />
      </Label>
      <Label text="Support link, shown as a QR code">
        <input
          className={`${inputCls} w-full`}
          value={idle.supportUrl ?? ''}
          placeholder="https://help.example.com"
          onChange={(e) => change((p) => void (p.idle.supportUrl = e.target.value || undefined))}
        />
      </Label>
    </div>
  );
}

export function SettingsPanel({ model, update, issues }: PanelProps) {
  const s = model.settings;
  return (
    <div className="max-w-xl space-y-5">
      <Label text="Default volume (0–100)">
        <NumberField
          value={s.defaultVolume}
          min={0}
          max={100}
          onChange={(v) => update((m) => void (m.settings.defaultVolume = v))}
        />
      </Label>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.autoOff.enabled}
            onChange={(e) => update((m) => void (m.settings.autoOff.enabled = e.target.checked))}
          />
          Turn the room off automatically when idle
        </label>
        <Label text="Warn this many seconds before turning off">
          <NumberField
            value={s.autoOff.warnSeconds}
            min={0}
            max={600}
            onChange={(v) => update((m) => void (m.settings.autoOff.warnSeconds = v))}
          />
        </Label>
        <p className="text-xs text-muted-foreground">
          Auto-off never runs in rooms that cannot detect signal.
        </p>
      </div>
      <Label text="Seconds before switching to a second source that appears mid-activity">
        <NumberField
          value={s.sourceConflictSeconds}
          min={0}
          max={120}
          onChange={(v) => update((m) => void (m.settings.sourceConflictSeconds = v))}
        />
      </Label>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Extra controls shown to users</div>
        {(['lights', 'blinds', 'camera'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm capitalize">
            <input
              type="checkbox"
              checked={s.userControls[k]}
              onChange={(e) => update((m) => void (m.settings.userControls[k] = e.target.checked))}
            />
            {k}
          </label>
        ))}
      </div>
      <PanelSection model={model} update={update} issues={issues} />
    </div>
  );
}
