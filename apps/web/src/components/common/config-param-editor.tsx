'use client';
import { Plus, Trash2 } from 'lucide-react';
import { CONFIG_FIELDS, CONFIG_MODES, CONFIG_MODE_LABEL, type ConfigParam } from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MODE_SHORT: Record<string, string> = {
  watch: 'Watch',
  enforce: 'Enforce',
  once: 'Apply once',
};

/** The value control for one setting: a choice for on/off, a number for a level. */
function ValueInput({
  field,
  value,
  onChange,
}: {
  field: string;
  value: ConfigParam['value'];
  onChange: (v: ConfigParam['value']) => void;
}) {
  const info = CONFIG_FIELDS[field];
  if (info?.type === 'enum' && info.options)
    return (
      <SimpleSelect
        size="sm"
        className="w-28"
        value={String(value)}
        onValueChange={onChange}
        options={info.options.map((o) => ({ value: o, label: o }))}
      />
    );
  if (info?.type === 'boolean')
    return (
      <SimpleSelect
        size="sm"
        className="w-28"
        value={String(value)}
        onValueChange={(v) => onChange(v === 'true')}
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]}
      />
    );
  return (
    <Input
      type="number"
      className="h-8 w-28"
      min={info?.min}
      max={info?.max}
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label="Value"
    />
  );
}

const defaultValue = (field: string): ConfigParam['value'] => {
  const info = CONFIG_FIELDS[field];
  if (!info) return '';
  if (info.type === 'enum') return info.options?.[0] ?? '';
  if (info.type === 'boolean') return true;
  return info.min ?? 0;
};

/**
 * Edits a list of held settings. `available` limits what can be added: for a device, only what it
 * reports, so nothing is offered that cannot exist on it.
 */
export function ConfigParamEditor({
  value,
  onChange,
  available,
  disabled,
}: {
  value: ConfigParam[];
  onChange: (p: ConfigParam[]) => void;
  available: { field: string; label: string }[];
  disabled?: boolean;
}) {
  const unused = available.filter((a) => !value.some((p) => p.field === a.field));
  const set = (i: number, patch: Partial<ConfigParam>) =>
    onChange(value.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing is held to a value yet.</p>
      )}
      {value.map((p, i) => (
        <div key={p.field} className="flex flex-wrap items-center gap-2">
          <span className="w-36 text-sm">{CONFIG_FIELDS[p.field]?.label ?? p.field}</span>
          <span className="text-xs text-muted-foreground">should be</span>
          <ValueInput
            field={p.field}
            value={p.value}
            onChange={(v) => !disabled && set(i, { value: v })}
          />
          <SimpleSelect
            size="sm"
            className="w-36"
            value={p.mode}
            disabled={disabled}
            onValueChange={(v) => set(i, { mode: v as ConfigParam['mode'] })}
            options={CONFIG_MODES.map((m) => ({ value: m, label: MODE_SHORT[m]! }))}
          />
          {!disabled && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove"
              onClick={() => onChange(value.filter((_, n) => n !== i))}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
      {!disabled && unused.length > 0 && (
        <SimpleSelect
          size="sm"
          className="w-52"
          value=""
          placeholder="Add a setting"
          onValueChange={(f) =>
            onChange([...value, { field: f, value: defaultValue(f), mode: 'watch' }])
          }
          options={unused.map((u) => ({ value: u.field, label: u.label }))}
        />
      )}
      {!disabled && unused.length === 0 && available.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plus className="size-3" /> This device has not reported anything Kestrel can hold to a
          value yet.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {CONFIG_MODE_LABEL.watch}. {CONFIG_MODE_LABEL.enforce}. {CONFIG_MODE_LABEL.once}.
      </p>
    </div>
  );
}
