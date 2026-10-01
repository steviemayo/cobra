'use client';
import { Plus, Trash2 } from 'lucide-react';
import {
  DEVICE_CATALOG,
  DeviceCategory,
  assetCategoryLabel,
  type UsageCondition,
  type UsageRule,
} from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// A small builder for "what counts as in use": groups joined by AND or OR, NOT, and conditions on a
// reading of a device (or of any device of a kind). Nothing here needs to know a driver.

export const FIELD_OPTIONS = [
  { value: 'power', label: 'Power' },
  { value: 'occupied', label: 'Occupied' },
  { value: 'recording', label: 'Recording' },
  { value: 'streamConnected', label: 'Receiving a stream' },
  { value: 'input', label: 'Input' },
  { value: 'muted', label: 'Muted' },
  { value: 'volume', label: 'Volume' },
  { value: 'blanked', label: 'Picture blanked' },
  { value: 'activeApp', label: 'Active app' },
  { value: 'playback', label: 'Playback' },
  { value: 'online', label: 'Answering (online)' },
];
const COMPARE_OPTIONS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'gt', label: 'is above' },
  { value: 'lt', label: 'is below' },
  { value: 'present', label: 'has a signal / is on' },
];
const KIND_OPTIONS = DeviceCategory.options.map((c) => ({
  value: `kind:${c}`,
  label: `Any ${DEVICE_CATALOG[c].label.toLowerCase()}`,
}));

export interface RuleDeviceOption {
  id: string;
  name: string;
  category: string;
}

const newCondition = (): UsageCondition => ({
  op: 'cond',
  category: 'display',
  field: 'power',
  cmp: 'eq',
  value: 'on',
});

function ConditionRow({
  rule,
  devices,
  onChange,
  onRemove,
}: {
  rule: UsageCondition;
  devices: RuleDeviceOption[];
  onChange: (r: UsageCondition) => void;
  onRemove?: () => void;
}) {
  const target = rule.deviceId ? `device:${rule.deviceId}` : `kind:${rule.category ?? 'display'}`;
  const targets = [
    ...devices.map((d) => ({
      value: `device:${d.id}`,
      label: `${d.name} (${assetCategoryLabel(d.category)})`,
    })),
    ...KIND_OPTIONS,
  ];
  const set = (patch: Partial<UsageCondition>) => onChange({ ...rule, ...patch });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SimpleSelect
        size="sm"
        className="w-56"
        value={target}
        onValueChange={(v) => {
          const next = { ...rule };
          delete next.deviceId;
          delete next.category;
          if (v.startsWith('device:')) next.deviceId = v.slice(7);
          else next.category = v.slice(5);
          onChange(next);
        }}
        options={targets}
      />
      <SimpleSelect
        size="sm"
        className="w-44"
        value={rule.field}
        onValueChange={(v) => set({ field: v })}
        options={
          FIELD_OPTIONS.some((f) => f.value === rule.field)
            ? FIELD_OPTIONS
            : [...FIELD_OPTIONS, { value: rule.field, label: rule.field }]
        }
      />
      <SimpleSelect
        size="sm"
        className="w-40"
        value={rule.cmp}
        onValueChange={(v) => set({ cmp: v as UsageCondition['cmp'] })}
        options={COMPARE_OPTIONS}
      />
      {rule.cmp !== 'present' && (
        <Input
          className="h-8 w-28"
          value={rule.value === undefined ? '' : String(rule.value)}
          onChange={(e) => {
            const raw = e.target.value;
            const v: string | number | boolean =
              raw === 'true'
                ? true
                : raw === 'false'
                  ? false
                  : raw !== '' && !Number.isNaN(Number(raw))
                    ? Number(raw)
                    : raw;
            set({ value: raw === '' ? undefined : v });
          }}
          placeholder="on, true, 40"
          aria-label="Value"
          maxLength={100}
        />
      )}
      {onRemove && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Remove this condition"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function Group({
  rule,
  devices,
  onChange,
  onRemove,
  depth,
}: {
  rule: Extract<UsageRule, { op: 'and' | 'or' }>;
  devices: RuleDeviceOption[];
  onChange: (r: UsageRule) => void;
  onRemove?: () => void;
  depth: number;
}) {
  const setChild = (i: number, r: UsageRule | null) => {
    const rules = rule.rules.flatMap((c, n) => (n === i ? (r ? [r] : []) : [c]));
    onChange({ ...rule, rules: rules.length ? rules : [newCondition()] });
  };
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">In use when</span>
        <SimpleSelect
          size="sm"
          className="w-32"
          value={rule.op}
          onValueChange={(v) => onChange({ ...rule, op: v as 'and' | 'or' })}
          options={[
            { value: 'or', label: 'any of these' },
            { value: 'and', label: 'all of these' },
          ]}
        />
        {onRemove && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto"
            aria-label="Remove this group"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="space-y-2 pl-2">
        {rule.rules.map((child, i) => (
          <RuleNode
            key={i}
            rule={child}
            devices={devices}
            depth={depth + 1}
            onChange={(r) => setChild(i, r)}
            onRemove={() => setChild(i, null)}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => onChange({ ...rule, rules: [...rule.rules, newCondition()] })}
        >
          <Plus data-icon="inline-start" /> Condition
        </Button>
        {depth < 3 && (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              onChange({ ...rule, rules: [...rule.rules, { op: 'and', rules: [newCondition()] }] })
            }
          >
            <Plus data-icon="inline-start" /> Group
          </Button>
        )}
      </div>
    </div>
  );
}

function RuleNode({
  rule,
  devices,
  onChange,
  onRemove,
  depth,
}: {
  rule: UsageRule;
  devices: RuleDeviceOption[];
  onChange: (r: UsageRule) => void;
  onRemove?: () => void;
  depth: number;
}) {
  if (rule.op === 'cond')
    return <ConditionRow rule={rule} devices={devices} onChange={onChange} onRemove={onRemove} />;
  if (rule.op === 'not')
    return (
      <div className="flex items-start gap-2">
        <span className="pt-1.5 text-xs font-medium text-muted-foreground">NOT</span>
        <div className="flex-1">
          <RuleNode
            rule={rule.rule}
            devices={devices}
            depth={depth + 1}
            onChange={(r) => onChange({ op: 'not', rule: r })}
          />
        </div>
        {onRemove && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove"
            onClick={() => onChange(rule.rule)}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    );
  return (
    <Group rule={rule} devices={devices} depth={depth} onChange={onChange} onRemove={onRemove} />
  );
}

/** The whole rule. A lone condition is wrapped in a group so more can be added. */
export function UsageRuleEditor({
  value,
  onChange,
  devices = [],
}: {
  value: UsageRule;
  onChange: (r: UsageRule) => void;
  devices?: RuleDeviceOption[];
}) {
  const root: Extract<UsageRule, { op: 'and' | 'or' }> =
    value.op === 'and' || value.op === 'or' ? value : { op: 'or', rules: [value] };
  return <Group rule={root} devices={devices} depth={0} onChange={onChange} />;
}
