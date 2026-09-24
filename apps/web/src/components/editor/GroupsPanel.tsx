'use client';
import { useState } from 'react';
import type { Group } from '@kestrel/model';
import { devicesWith, uniqueId } from '@/lib/editor/ops';
import {
  Card,
  CheckList,
  ConfirmButton,
  Label,
  Select,
  TextInput,
  btnCls,
  issuesFor,
  type PanelProps,
} from './ui';

const toggle = (list: string[], id: string, on: boolean) =>
  on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);

export function GroupsPanel({ model, update, issues }: PanelProps) {
  const [kind, setKind] = useState<Group['kind']>('display');
  const edit = (id: string, fn: (g: Group) => void) =>
    update((m) => {
      const g = m.groups.find((x) => x.id === id);
      if (g) fn(g);
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select
          value={kind}
          options={[
            { value: 'display', label: 'Display group' },
            { value: 'audio', label: 'Audio group' },
          ]}
          onChange={setKind}
        />
        <button
          className={btnCls}
          onClick={() =>
            update((m) => {
              const name = kind === 'display' ? 'Displays' : 'Audio';
              m.groups.push({
                id: uniqueId(
                  name,
                  m.groups.map((g) => g.id),
                ),
                name,
                kind,
                members: [],
                allowedSources: [],
                mode: 'follow',
              });
            })
          }
        >
          Add group
        </button>
      </div>
      {model.groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Groups let several displays or speakers act together, with a set of allowed sources.
        </p>
      )}
      {model.groups.map((g) => {
        const members = devicesWith(model, g.kind === 'display' ? 'video_sink' : 'audio_sink');
        const sources = devicesWith(model, 'video_source', 'audio_source');
        return (
          <Card key={g.id} issues={issuesFor(issues, 'group', g.id)}>
            <div className="flex flex-wrap items-end gap-3">
              <Label text="Name">
                <TextInput value={g.name} onChange={(v) => edit(g.id, (x) => (x.name = v))} />
              </Label>
              <Label text="Mode">
                <Select
                  value={g.mode}
                  options={[
                    { value: 'follow', label: 'Follow (same source)' },
                    { value: 'independent', label: 'Independent' },
                  ]}
                  onChange={(v) => edit(g.id, (x) => (x.mode = v))}
                />
              </Label>
              <span className="text-xs text-muted-foreground">{g.kind} group</span>
              <div className="ml-auto">
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Delete group"
                  onConfirm={() =>
                    update((m) => void (m.groups = m.groups.filter((x) => x.id !== g.id)))
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Members</div>
              <CheckList
                items={members.map((d) => ({ id: d.id, label: d.name }))}
                selected={g.members}
                onToggle={(id, on) => edit(g.id, (x) => (x.members = toggle(x.members, id, on)))}
                empty={`No ${g.kind === 'display' ? 'displays' : 'speakers'} in the room yet.`}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Allowed sources</div>
              <CheckList
                items={sources.map((d) => ({ id: d.id, label: d.name }))}
                selected={g.allowedSources}
                onToggle={(id, on) =>
                  edit(g.id, (x) => (x.allowedSources = toggle(x.allowedSources, id, on)))
                }
                empty="No sources in the room yet."
              />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
