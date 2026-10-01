import { pointToLevel, type ControlPoint } from '@kestrel/model';

// Building the control points for a Q-SYS Core from what a person types: a named component (a gain
// block, or a router), or a named control on its own. Kept apart from the screen so it can be tested.

/** A Q-SYS gain control runs from -100 dB to +20 dB. */
export const GAIN_MIN_DB = -100;
export const GAIN_MAX_DB = 20;

/** A point id from a name: letters, numbers, - and _ only, kept short. */
export function slug(name: string): string {
  const s = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return s || 'point';
}

/** Makes ids unique against those already used, by numbering the later ones. */
export function uniqueIds(points: ControlPoint[], taken: Iterable<string>): ControlPoint[] {
  const used = new Set(taken);
  return points.map((p) => {
    let id = p.id;
    for (let n = 2; used.has(id); n++) id = `${p.id.slice(0, 60)}-${n}`;
    used.add(id);
    return { ...p, id };
  });
}

/** The 0 to 100 value a dB threshold is checked against (the point's range maps dB onto 0 to 100). */
const levelOf = (db: number) => pointToLevel({ min: GAIN_MIN_DB, max: GAIN_MAX_DB }, db);

export interface GainOptions {
  /** Raise an incident when the gain falls below this many dB. */
  minDb?: number | null;
  /** ...or goes above this many dB. */
  maxDb?: number | null;
  /** Raise an incident when the mute is not this (false: it should be off). Null: do not watch it. */
  muteShouldBe?: boolean | null;
  severity?: 'info' | 'warning' | 'critical';
}

/** A gain component: its `gain` (a level in dB) and its `mute` (on or off). */
export function gainPoints(component: string, o: GainOptions = {}): ControlPoint[] {
  const name = component.trim();
  const base = slug(name);
  const severity = o.severity ?? 'warning';
  const watchLevel =
    (o.minDb ?? null) !== null || (o.maxDb ?? null) !== null
      ? {
          ...(o.minDb != null ? { min: levelOf(o.minDb) } : {}),
          ...(o.maxDb != null ? { max: levelOf(o.maxDb) } : {}),
          severity,
        }
      : undefined;
  return [
    {
      id: `${base}-gain`,
      name: `${name} level`,
      type: 'level',
      address: { component: name, control: 'gain' },
      min: GAIN_MIN_DB,
      max: GAIN_MAX_DB,
      ...(watchLevel && { watch: watchLevel }),
    },
    {
      id: `${base}-mute`,
      name: `${name} mute`,
      type: 'mute',
      address: { component: name, control: 'mute' },
      ...(o.muteShouldBe != null && { watch: { expect: o.muteShouldBe, severity } }),
    },
  ];
}

/** A router component: one selector per output, `select.1` to `select.n`, each reading the input chosen. */
export function routerPoints(component: string, outputs: number): ControlPoint[] {
  const name = component.trim();
  const base = slug(name);
  const n = Math.max(1, Math.min(64, Math.floor(outputs)));
  return Array.from({ length: n }, (_, i) => ({
    id: `${base}-out${i + 1}`,
    name: `${name} output ${i + 1}`,
    type: 'select' as const,
    address: { component: name, control: `select.${i + 1}` },
  }));
}

export type NamedControlType = 'boolean' | 'integer' | 'text';

/** A named control on its own: on or off, a whole number, or text. */
export function namedControlPoint(
  name: string,
  valueType: NamedControlType,
  expect?: boolean | number | string | null,
  severity: 'info' | 'warning' | 'critical' = 'warning',
): ControlPoint {
  const n = name.trim();
  return {
    id: `ctl-${slug(n)}`,
    name: n,
    type: 'generic',
    valueType,
    address: { control: n },
    ...(expect !== null &&
      expect !== undefined &&
      expect !== '' && { watch: { expect, severity } }),
  };
}
