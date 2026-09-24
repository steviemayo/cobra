'use client';
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

export function SettingsPanel({ model, update }: PanelProps) {
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
        <p className="text-xs text-slate-500">
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
        <div className="text-xs text-slate-400">Extra controls shown to users</div>
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
    </div>
  );
}
