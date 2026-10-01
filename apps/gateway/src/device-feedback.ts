import {
  DEVICE_FEEDBACK_FIELDS,
  type DeviceFeedback,
  type DeviceFeedbackField,
  type DeviceState,
  type Port,
} from '@kestrel/model';

/**
 * Which feedback fields changed between two readings, and their new values. Compares only the
 * fields `DeviceFeedback` knows about, in a fixed order, so callers get a stable, small diff rather
 * than every field the object happens to carry.
 */
export function feedbackChanges(
  prev: DeviceFeedback,
  next: DeviceFeedback,
): [DeviceFeedbackField, DeviceFeedback[DeviceFeedbackField]][] {
  return DEVICE_FEEDBACK_FIELDS.flatMap((field) =>
    next[field] !== undefined && next[field] !== prev[field] ? [[field, next[field]] as const] : [],
  );
}

/**
 * Whatever the driver reports back for one device, in the shape the cloud stores: an input's port
 * id resolved to its name, and every other field carried over as is. Control or not, since none of
 * this is a command — it is what `reports()` sends up alongside `online`.
 */
export function deviceFeedback(state: DeviceState | undefined, ports: Port[]): DeviceFeedback {
  const feedback: DeviceFeedback = {};
  if (state?.power) feedback.power = state.power;
  if (state?.selectedInput) {
    const port = ports.find((p) => p.id === state.selectedInput);
    if (port) feedback.input = port.name;
  }
  if (state?.muted !== undefined) feedback.muted = state.muted;
  if (state?.volume !== undefined) feedback.volume = state.volume;
  if (state?.blanked !== undefined) feedback.blanked = state.blanked;
  if (state?.recording !== undefined) feedback.recording = state.recording;
  if (state?.occupied !== undefined) feedback.occupied = state.occupied;
  if (state?.streamConnected !== undefined) feedback.streamConnected = state.streamConnected;
  if (state?.activeApp !== undefined) feedback.activeApp = state.activeApp;
  return feedback;
}
