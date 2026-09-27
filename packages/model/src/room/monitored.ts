import type { RoomModel } from './room-model';

// A room on a plan without control is a monitored room: its devices, their addresses and what to
// watch, but no routing, states, activities or triggers. These say what counts as the control side
// of a design, so the portal can hide it and the API can refuse to save it.
export const CONTROL_CONTENT = [
  'connections',
  'groups',
  'states',
  'activities',
  'triggers',
] as const;
export type ControlContentKey = (typeof CONTROL_CONTENT)[number];

/** Which parts of the control side a design has (a monitored room should have none). */
export function controlContentIn(model: RoomModel): ControlContentKey[] {
  return CONTROL_CONTENT.filter((k) => model[k].length > 0);
}

/** Whether saving `after` over `before` adds or changes anything on the control side. */
export function changesControlContent(before: RoomModel | null, after: RoomModel): boolean {
  return CONTROL_CONTENT.some(
    (k) => JSON.stringify(before?.[k] ?? []) !== JSON.stringify(after[k]),
  );
}
