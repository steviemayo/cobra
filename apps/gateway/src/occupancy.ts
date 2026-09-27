// Whether anyone is in a room, from all its occupancy sensors together: occupied while any sensor
// says so. The callback fires only when the answer changes, and once when the first sensor reports.
export function occupancyTracker(emit: (occupied: boolean, deviceId: string) => void) {
  const seen = new Map<string, boolean>();
  let last: boolean | undefined;
  return (deviceId: string, occupied: boolean | undefined) => {
    if (occupied === undefined) return;
    seen.set(deviceId, occupied);
    const now = [...seen.values()].some(Boolean);
    if (now === last) return;
    last = now;
    emit(now, deviceId);
  };
}
