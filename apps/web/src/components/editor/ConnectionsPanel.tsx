'use client';
import { useState } from 'react';
import { addConnection, removeConnection } from '@/lib/editor/ops';
import { Card, Select, btnCls, dangerBtnCls, issuesFor, type PanelProps } from './ui';

const SEP = '\u0000';

export function ConnectionsPanel({ model, update, issues }: PanelProps) {
  const outs = model.devices.flatMap((d) =>
    d.ports
      .filter((p) => p.direction === 'out')
      .map((p) => ({ value: `${d.id}${SEP}${p.id}`, label: `${d.name} → ${p.name}` })),
  );
  const ins = model.devices.flatMap((d) =>
    d.ports
      .filter((p) => p.direction === 'in')
      .map((p) => ({ value: `${d.id}${SEP}${p.id}`, label: `${d.name} → ${p.name}` })),
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  const label = (deviceId: string, portId: string) => {
    const d = model.devices.find((x) => x.id === deviceId);
    return `${d?.name ?? deviceId} · ${d?.ports.find((p) => p.id === portId)?.name ?? portId}`;
  };

  const fromValue = from || outs[0]?.value || '';
  const toValue = to || ins[0]?.value || '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={fromValue}
          options={outs.length ? outs : [{ value: '', label: 'No outputs' }]}
          onChange={setFrom}
        />
        <span className="text-slate-500">to</span>
        <Select
          value={toValue}
          options={ins.length ? ins : [{ value: '', label: 'No inputs' }]}
          onChange={setTo}
        />
        <button
          className={btnCls}
          disabled={!fromValue || !toValue}
          onClick={() => {
            const [fd, fp] = fromValue.split(SEP) as [string, string];
            const [td, tp] = toValue.split(SEP) as [string, string];
            let reason = '';
            update((m) => {
              const r = addConnection(
                m,
                { deviceId: fd, portId: fp },
                { deviceId: td, portId: tp },
              );
              if (!r.ok) reason = r.reason;
            });
            setError(reason);
          }}
        >
          Connect
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <p className="text-xs text-slate-500">
        Tip: you can also drag between ports in the Graph tab.
      </p>
      {model.connections.length === 0 && (
        <p className="text-sm text-slate-400">No connections yet.</p>
      )}
      {model.connections.map((c) => (
        <Card key={c.id} issues={issuesFor(issues, 'connection', c.id)}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>
              {label(c.from.deviceId, c.from.portId)} <span className="text-slate-500">→</span>{' '}
              {label(c.to.deviceId, c.to.portId)}
            </span>
            <button
              className={dangerBtnCls}
              onClick={() => update((m) => removeConnection(m, c.id))}
            >
              Remove
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}
