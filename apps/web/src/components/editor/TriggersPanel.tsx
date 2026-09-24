'use client';
import { useState } from 'react';
import type { Trigger } from '@kestrel/model';
import { TRIGGER_TYPES, newTrigger, type TriggerType } from '@/lib/editor/ops';
import {
  Card,
  ConfirmButton,
  Label,
  Select,
  TextInput,
  btnCls,
  deviceOptions,
  issuesFor,
  type PanelProps,
} from './ui';

export function TriggersPanel({ model, update, issues }: PanelProps) {
  const [type, setType] = useState<TriggerType>('signal_detect');
  const canAdd = newTrigger(model, type) !== null;
  const edit = (id: string, fn: (t: Trigger) => void) =>
    update((m) => {
      const t = m.triggers.find((x) => x.id === id);
      if (t) fn(t);
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select
          value={type}
          options={TRIGGER_TYPES.map((t) => ({ value: t.type, label: t.label }))}
          onChange={setType}
        />
        <button
          className={btnCls}
          disabled={!canAdd}
          title={canAdd ? '' : 'Add an activity or state (and a device for sensor triggers) first'}
          onClick={() =>
            update((m) => {
              const t = newTrigger(m, type);
              if (t) m.triggers.push(t);
            })
          }
        >
          Add trigger
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Triggers start an activity or state automatically, e.g. when a laptop is plugged in.
      </p>
      {model.triggers.map((t) => (
        <Card key={t.id} issues={issuesFor(issues, 'trigger', t.id)}>
          <div className="flex flex-wrap items-end gap-3">
            <Label text="Name">
              <TextInput value={t.name} onChange={(v) => edit(t.id, (x) => (x.name = v))} />
            </Label>
            <span className="pb-1 text-xs text-slate-400">
              {TRIGGER_TYPES.find((x) => x.type === t.type)?.label}
            </span>
            <label className="flex items-center gap-1.5 pb-1 text-sm">
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => edit(t.id, (x) => (x.enabled = e.target.checked))}
              />
              Enabled
            </label>
            <div className="ml-auto">
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete trigger"
                onConfirm={() =>
                  update((m) => void (m.triggers = m.triggers.filter((x) => x.id !== t.id)))
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {(t.type === 'signal_detect' || t.type === 'occupancy') && (
              <Label text="Device">
                <Select
                  value={t.deviceId}
                  options={
                    model.devices.some((d) => d.id === t.deviceId)
                      ? deviceOptions(model)
                      : [
                          { value: t.deviceId, label: `${t.deviceId} (missing)` },
                          ...deviceOptions(model),
                        ]
                  }
                  onChange={(v) => edit(t.id, (x) => 'deviceId' in x && (x.deviceId = v))}
                />
              </Label>
            )}
            {t.type === 'occupancy' && (
              <Label text="When room becomes">
                <Select
                  value={t.occupied ? 'occupied' : 'empty'}
                  options={[
                    { value: 'occupied', label: 'Occupied' },
                    { value: 'empty', label: 'Empty' },
                  ]}
                  onChange={(v) =>
                    edit(t.id, (x) => x.type === 'occupancy' && (x.occupied = v === 'occupied'))
                  }
                />
              </Label>
            )}
            {t.type === 'schedule' && (
              <>
                <Label text="Cron (min hour day month weekday)">
                  <TextInput
                    value={t.cron}
                    onChange={(v) => edit(t.id, (x) => x.type === 'schedule' && (x.cron = v))}
                  />
                </Label>
                <Label text="Timezone">
                  <TextInput
                    value={t.timezone}
                    onChange={(v) => edit(t.id, (x) => x.type === 'schedule' && (x.timezone = v))}
                  />
                </Label>
              </>
            )}
            {t.type === 'calendar' && (
              <>
                <Label text="Provider">
                  <Select
                    value={t.provider}
                    options={[
                      { value: 'graph', label: 'Microsoft 365' },
                      { value: 'google', label: 'Google' },
                    ]}
                    onChange={(v) => edit(t.id, (x) => x.type === 'calendar' && (x.provider = v))}
                  />
                </Label>
                <Label text="Room calendar">
                  <TextInput
                    value={t.resourceId}
                    onChange={(v) => edit(t.id, (x) => x.type === 'calendar' && (x.resourceId = v))}
                  />
                </Label>
              </>
            )}
            {t.type === 'webhook' && (
              <Label text="Hook name">
                <TextInput
                  value={t.hookName}
                  onChange={(v) =>
                    edit(
                      t.id,
                      (x) =>
                        x.type === 'webhook' && (x.hookName = v.replace(/[^A-Za-z0-9_-]/g, '-')),
                    )
                  }
                />
              </Label>
            )}
          </div>

          <RunTarget model={model} trigger={t} edit={(fn) => edit(t.id, fn)} />
        </Card>
      ))}
    </div>
  );
}

function RunTarget({
  model,
  trigger: t,
  edit,
}: {
  model: PanelProps['model'];
  trigger: Trigger;
  edit: (fn: (t: Trigger) => void) => void;
}) {
  const run = t.run;
  const activity =
    run.type === 'activity' ? model.activities.find((a) => a.id === run.activityId) : undefined;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Label text="Then">
        <Select
          value={t.run.type}
          options={[
            { value: 'activity', label: 'Start activity' },
            { value: 'state', label: 'Set state' },
          ]}
          onChange={(v) =>
            edit((x) => {
              if (v === 'activity' && model.activities[0])
                x.run = { type: 'activity', activityId: model.activities[0].id };
              if (v === 'state' && model.states[0])
                x.run = { type: 'state', stateId: model.states[0].id };
            })
          }
        />
      </Label>
      {run.type === 'activity' ? (
        <>
          <Select
            value={run.activityId}
            options={
              activity
                ? model.activities.map((a) => ({ value: a.id, label: a.name }))
                : [
                    { value: run.activityId, label: `${run.activityId} (missing)` },
                    ...model.activities.map((a) => ({ value: a.id, label: a.name })),
                  ]
            }
            onChange={(v) =>
              edit((x) => {
                x.run = { type: 'activity', activityId: v };
              })
            }
          />
          {activity && activity.sources.length > 0 && (
            <Select
              value={run.sourceId ?? ''}
              options={[
                { value: '', label: 'Any source' },
                ...activity.sources.map((s) => ({ value: s.id, label: s.label })),
              ]}
              onChange={(v) =>
                edit((x) => {
                  if (x.run.type === 'activity')
                    x.run = v
                      ? { ...x.run, sourceId: v }
                      : { type: 'activity', activityId: x.run.activityId };
                })
              }
            />
          )}
        </>
      ) : (
        <Select
          value={run.stateId}
          options={
            model.states.some((s) => s.id === run.stateId)
              ? model.states.map((s) => ({ value: s.id, label: s.name }))
              : [
                  { value: run.stateId, label: `${run.stateId} (missing)` },
                  ...model.states.map((s) => ({ value: s.id, label: s.name })),
                ]
          }
          onChange={(v) => edit((x) => void (x.run = { type: 'state', stateId: v }))}
        />
      )}
    </div>
  );
}
