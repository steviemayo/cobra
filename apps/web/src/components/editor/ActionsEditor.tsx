'use client';
import { useState } from 'react';
import type { Action, ActionType, RoomModel } from '@kestrel/model';
import { ACTION_TYPES, actionTargets, devicesWith, newAction } from '@/lib/editor/ops';
import { Select, TextInput, dangerBtnCls, ghostBtnCls, inputCls } from './ui';

export function describeAction(model: RoomModel, a: Action): string {
  const name = (id: string) => model.devices.find((d) => d.id === id)?.name ?? id;
  switch (a.type) {
    case 'power':
      return `Power ${a.on ? 'on' : 'off'} ${name(a.deviceId)}`;
    case 'route':
      return `Route ${name(a.sourceDeviceId)} to ${name(a.destinationDeviceId)}`;
    case 'preset':
    case 'camera_preset':
      return `${name(a.deviceId)}: preset ${a.preset}`;
    case 'mute':
      return `${a.muted ? 'Mute' : 'Unmute'} ${name(a.deviceId)}`;
    case 'volume':
      return `${name(a.deviceId)}: volume ${a.level}`;
    case 'device_command':
      return `${name(a.deviceId)}: ${a.command}`;
    case 'env_scene':
      return `${name(a.deviceId)}: scene ${a.scene}`;
    case 'run_state':
      return `Run state ${model.states.find((s) => s.id === a.stateId)?.name ?? a.stateId}`;
  }
}

export function ActionsEditor({
  model,
  actions,
  mutate,
}: {
  model: RoomModel;
  actions: Action[];
  /** Runs `fn` against the live actions array of the owning state/activity. */
  mutate: (fn: (actions: Action[]) => void) => void;
}) {
  const [type, setType] = useState<ActionType>('power');
  const edit = (id: string, fn: (a: Action) => void) =>
    mutate((list) => {
      const a = list.find((x) => x.id === id);
      if (a) fn(a);
    });
  const canAdd = newAction(model, type, actions) !== null;

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Actions</div>
      {actions.length === 0 && <p className="text-xs text-muted-foreground">No actions.</p>}
      {actions.map((a) => (
        <div key={a.id} className="space-y-1 rounded border border-border p-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
            <ActionFields model={model} action={a} edit={(fn) => edit(a.id, fn)} />
            <button
              className={`${dangerBtnCls} ml-auto`}
              onClick={() =>
                mutate((list) => {
                  const i = list.findIndex((x) => x.id === a.id);
                  if (i >= 0) list.splice(i, 1);
                  for (const other of list)
                    other.dependsOn = other.dependsOn.filter((d) => d !== a.id);
                })
              }
            >
              Remove
            </button>
          </div>
          {actions.length > 1 && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {a.dependsOn.length
                  ? `Runs after: ${a.dependsOn.join(', ')}`
                  : 'Runs immediately, in parallel'}
              </summary>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {actions
                  .filter((o) => o.id !== a.id)
                  .map((o) => (
                    <label key={o.id} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={a.dependsOn.includes(o.id)}
                        onChange={(e) =>
                          edit(a.id, (x) => {
                            x.dependsOn = e.target.checked
                              ? [...x.dependsOn, o.id]
                              : x.dependsOn.filter((d) => d !== o.id);
                          })
                        }
                      />
                      {o.id}: {describeAction(model, o)}
                    </label>
                  ))}
              </div>
            </details>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Select
          value={type}
          options={ACTION_TYPES.map((t) => ({ value: t.type, label: t.label }))}
          onChange={setType}
        />
        <button
          className={ghostBtnCls}
          disabled={!canAdd}
          title={canAdd ? '' : 'The room has no device that supports this action yet'}
          onClick={() =>
            mutate((list) => {
              const a = newAction(model, type, list);
              if (a) list.push(a);
            })
          }
        >
          Add action
        </button>
      </div>
    </div>
  );
}

function ActionFields({
  model,
  action: a,
  edit,
}: {
  model: RoomModel;
  action: Action;
  edit: (fn: (a: Action) => void) => void;
}) {
  const deviceSelect = (
    value: string,
    devices: { id: string; name: string }[],
    set: (id: string) => void,
  ) => {
    const options = devices.map((d) => ({ value: d.id, label: d.name }));
    // Keep a stale selection visible so the validator message makes sense.
    if (!options.some((o) => o.value === value))
      options.unshift({ value, label: `${value} (unavailable)` });
    return <Select value={value} options={options} onChange={set} />;
  };

  switch (a.type) {
    case 'power':
      return (
        <>
          <Select
            value={a.on ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Power on' },
              { value: 'off', label: 'Power off' },
            ]}
            onChange={(v) => edit((x) => x.type === 'power' && (x.on = v === 'on'))}
          />
          {deviceSelect(a.deviceId, actionTargets(model, 'power'), (id) =>
            edit((x) => 'deviceId' in x && (x.deviceId = id)),
          )}
        </>
      );
    case 'route': {
      const sources = devicesWith(model, 'video_source', 'audio_source');
      const dests = devicesWith(model, 'video_sink', 'audio_sink');
      return (
        <>
          <span className="text-muted-foreground">Route</span>
          {deviceSelect(a.sourceDeviceId, sources, (id) =>
            edit((x) => x.type === 'route' && ((x.sourceDeviceId = id), delete x.sourcePortId)),
          )}
          <span className="text-muted-foreground">to</span>
          {deviceSelect(a.destinationDeviceId, dests, (id) =>
            edit(
              (x) =>
                x.type === 'route' && ((x.destinationDeviceId = id), delete x.destinationPortId),
            ),
          )}
        </>
      );
    }
    case 'preset':
    case 'camera_preset':
    case 'env_scene': {
      const field = a.type === 'env_scene' ? 'scene' : 'preset';
      const value = a.type === 'env_scene' ? a.scene : a.preset;
      return (
        <>
          <span className="text-muted-foreground">
            {a.type === 'env_scene'
              ? 'Scene'
              : a.type === 'camera_preset'
                ? 'Camera preset'
                : 'Preset'}
          </span>
          {deviceSelect(a.deviceId, actionTargets(model, a.type), (id) =>
            edit((x) => 'deviceId' in x && (x.deviceId = id)),
          )}
          <TextInput
            value={value}
            onChange={(v) =>
              edit((x) => {
                if (field === 'scene' && x.type === 'env_scene') x.scene = v;
                if (field === 'preset' && (x.type === 'preset' || x.type === 'camera_preset'))
                  x.preset = v;
              })
            }
          />
        </>
      );
    }
    case 'mute':
      return (
        <>
          <Select
            value={a.muted ? 'mute' : 'unmute'}
            options={[
              { value: 'mute', label: 'Mute' },
              { value: 'unmute', label: 'Unmute' },
            ]}
            onChange={(v) => edit((x) => x.type === 'mute' && (x.muted = v === 'mute'))}
          />
          {deviceSelect(a.deviceId, actionTargets(model, 'mute'), (id) =>
            edit((x) => 'deviceId' in x && (x.deviceId = id)),
          )}
        </>
      );
    case 'volume':
      return (
        <>
          <span className="text-muted-foreground">Volume</span>
          {deviceSelect(a.deviceId, actionTargets(model, 'volume'), (id) =>
            edit((x) => 'deviceId' in x && (x.deviceId = id)),
          )}
          <input
            type="number"
            min={0}
            max={100}
            className={`${inputCls} w-20`}
            value={a.level}
            onChange={(e) =>
              edit((x) => {
                if (x.type === 'volume')
                  x.level = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)));
              })
            }
          />
        </>
      );
    case 'device_command':
      return (
        <>
          <span className="text-muted-foreground">Command</span>
          {deviceSelect(a.deviceId, actionTargets(model, 'device_command'), (id) =>
            edit((x) => 'deviceId' in x && (x.deviceId = id)),
          )}
          <TextInput
            value={a.command}
            onChange={(v) => edit((x) => x.type === 'device_command' && (x.command = v))}
          />
        </>
      );
    case 'run_state':
      return (
        <>
          <span className="text-muted-foreground">Run state</span>
          <Select
            value={a.stateId}
            options={
              model.states.some((s) => s.id === a.stateId)
                ? model.states.map((s) => ({ value: s.id, label: s.name }))
                : [
                    { value: a.stateId, label: `${a.stateId} (missing)` },
                    ...model.states.map((s) => ({ value: s.id, label: s.name })),
                  ]
            }
            onChange={(id) => edit((x) => x.type === 'run_state' && (x.stateId = id))}
          />
        </>
      );
  }
}
