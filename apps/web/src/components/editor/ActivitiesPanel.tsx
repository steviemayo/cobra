'use client';
import { ActivityKind, Capability, type Activity } from '@kestrel/model';
import { generateDefaultActivities, uniqueId } from '@/lib/editor/ops';
import { ActionsEditor } from './ActionsEditor';
import {
  Card,
  CheckList,
  ConfirmButton,
  Label,
  Select,
  TextInput,
  btnCls,
  dangerBtnCls,
  deviceOptions,
  ghostBtnCls,
  issuesFor,
  type PanelProps,
} from './ui';

const kindOptions = ActivityKind.options.map((k) => ({ value: k, label: k.replace('_', ' ') }));

export function ActivitiesPanel({ model, update, issues }: PanelProps) {
  const edit = (id: string, fn: (a: Activity) => void) =>
    update((m) => {
      const a = m.activities.find((x) => x.id === id);
      if (a) fn(a);
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          className={btnCls}
          onClick={() =>
            update((m) =>
              m.activities.push({
                id: uniqueId(
                  'activity',
                  m.activities.map((a) => a.id),
                ),
                name: 'New activity',
                kind: 'custom',
                hidden: false,
                requires: [],
                sources: [],
                actions: [],
              }),
            )
          }
        >
          Add activity
        </button>
        <button
          className={ghostBtnCls}
          onClick={() => update((m) => void generateDefaultActivities(m))}
        >
          Add room-type defaults
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Activities are what people see on the panel: plain-language intents like Present or Room
        Off.
      </p>
      {model.activities.map((a) => (
        <Card key={a.id} issues={issuesFor(issues, 'activity', a.id)}>
          <div className="flex flex-wrap items-end gap-3">
            <Label text="Name shown on panel">
              <TextInput value={a.name} onChange={(v) => edit(a.id, (x) => (x.name = v))} />
            </Label>
            <Label text="Kind">
              <Select
                value={a.kind}
                options={kindOptions}
                onChange={(v) => edit(a.id, (x) => (x.kind = v))}
              />
            </Label>
            <label className="flex items-center gap-1.5 pb-1 text-sm">
              <input
                type="checkbox"
                checked={a.hidden}
                onChange={(e) => edit(a.id, (x) => (x.hidden = e.target.checked))}
              />
              Hidden
            </label>
            <div className="ml-auto">
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete activity"
                onConfirm={() =>
                  update((m) => {
                    m.activities = m.activities.filter((x) => x.id !== a.id);
                    m.triggers = m.triggers.filter(
                      (t) => !(t.run.type === 'activity' && t.run.activityId === a.id),
                    );
                  })
                }
              />
            </div>
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Needs in room: {a.requires.length ? a.requires.join(', ') : 'nothing'}
            </summary>
            <div className="mt-1">
              <CheckList
                items={Capability.options.map((c) => ({ id: c, label: c.replace('_', ' ') }))}
                selected={a.requires}
                onToggle={(id, on) =>
                  edit(a.id, (x) => {
                    const cap = id as Capability;
                    x.requires = on ? [...x.requires, cap] : x.requires.filter((c) => c !== cap);
                  })
                }
                empty=""
              />
            </div>
          </details>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">Sources the user can choose</span>
              <Label text="Shown on">
                <Select
                  value={a.targetGroupId ?? ''}
                  options={[
                    { value: '', label: 'No target group' },
                    ...model.groups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                  onChange={(v) =>
                    edit(a.id, (x) => {
                      if (v) x.targetGroupId = v;
                      else delete x.targetGroupId;
                    })
                  }
                />
              </Label>
            </div>
            {a.sources.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2">
                <TextInput
                  value={s.label}
                  onChange={(v) =>
                    edit(a.id, (x) => {
                      const src = x.sources.find((y) => y.id === s.id);
                      if (src) src.label = v;
                    })
                  }
                />
                <Select
                  value={s.deviceId}
                  options={
                    model.devices.some((d) => d.id === s.deviceId)
                      ? deviceOptions(model)
                      : [
                          { value: s.deviceId, label: `${s.deviceId} (missing)` },
                          ...deviceOptions(model),
                        ]
                  }
                  onChange={(v) =>
                    edit(a.id, (x) => {
                      const src = x.sources.find((y) => y.id === s.id);
                      if (src) {
                        src.deviceId = v;
                        delete src.portId;
                      }
                    })
                  }
                />
                <button
                  className={dangerBtnCls}
                  onClick={() =>
                    update((m) => {
                      const act = m.activities.find((x) => x.id === a.id);
                      if (!act) return;
                      act.sources = act.sources.filter((y) => y.id !== s.id);
                      m.triggers = m.triggers.filter(
                        (t) =>
                          !(
                            t.run.type === 'activity' &&
                            t.run.activityId === a.id &&
                            t.run.sourceId === s.id
                          ),
                      );
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className={ghostBtnCls}
              disabled={model.devices.length === 0}
              onClick={() =>
                edit(a.id, (x) => {
                  const first =
                    model.devices.find((d) => d.category === 'video_source') ?? model.devices[0];
                  if (!first) return;
                  x.sources.push({
                    id: uniqueId(
                      first.id,
                      x.sources.map((s) => s.id),
                    ),
                    label: first.name,
                    deviceId: first.id,
                  });
                })
              }
            >
              Add source
            </button>
          </div>

          <ActionsEditor
            model={model}
            actions={a.actions}
            mutate={(fn) => edit(a.id, (x) => fn(x.actions))}
          />
        </Card>
      ))}
    </div>
  );
}
