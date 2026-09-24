'use client';
import type { RoomState } from '@kestrel/model';
import { generateDefaultStates, uniqueId } from '@/lib/editor/ops';
import { ActionsEditor } from './ActionsEditor';
import {
  Card,
  ConfirmButton,
  Label,
  Select,
  TextInput,
  btnCls,
  ghostBtnCls,
  issuesFor,
  type PanelProps,
} from './ui';

export function StatesPanel({ model, update, issues }: PanelProps) {
  const edit = (id: string, fn: (s: RoomState) => void) =>
    update((m) => {
      const s = m.states.find((x) => x.id === id);
      if (s) fn(s);
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          className={btnCls}
          onClick={() =>
            update((m) =>
              m.states.push({
                id: uniqueId(
                  'state',
                  m.states.map((s) => s.id),
                ),
                name: 'New state',
                kind: 'custom',
                actions: [],
              }),
            )
          }
        >
          Add state
        </button>
        <button
          className={ghostBtnCls}
          onClick={() => update((m) => void generateDefaultStates(m))}
        >
          Generate Off / On from device power
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        A state is a named set of actions the room can be put into, such as Off or On.
      </p>
      {model.states.map((s) => (
        <Card key={s.id} issues={issuesFor(issues, 'state', s.id)}>
          <div className="flex flex-wrap items-end gap-3">
            <Label text="Name">
              <TextInput value={s.name} onChange={(v) => edit(s.id, (x) => (x.name = v))} />
            </Label>
            <Label text="Kind">
              <Select
                value={s.kind}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'on', label: 'On' },
                  { value: 'custom', label: 'Custom' },
                ]}
                onChange={(v) => edit(s.id, (x) => (x.kind = v))}
              />
            </Label>
            <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
            <div className="ml-auto">
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete state"
                onConfirm={() =>
                  update((m) => void (m.states = m.states.filter((x) => x.id !== s.id)))
                }
              />
            </div>
          </div>
          <ActionsEditor
            model={model}
            actions={s.actions}
            mutate={(fn) => edit(s.id, (x) => fn(x.actions))}
          />
        </Card>
      ))}
    </div>
  );
}
