import type { PanelText } from '@kestrel/model';

// Every string a panel shows. Add a language by supplying another Dictionary; missing keys fall
// back to English. `{name}` placeholders are filled from params.
export const en = {
  // Messages produced by the engine
  ready: 'Ready to go.',
  starting: 'Getting the room ready…',
  stopping: 'Turning the room off…',
  room_off: 'The room is off. Choose what you would like to do.',
  presenting: 'Showing {source}.',
  plug_in_source: 'Plug in your cable for {source}.',
  recording: 'Recording. Microphones are live.',
  recording_saved: 'Recording saved.',
  fault_device: "{device} isn't responding. Try again, or contact support.",
  fault_generic: 'Something went wrong. Try again, or contact support.',
  switch_source: '{source} was just plugged in. Switch to it?',
  auto_off: 'Nobody seems to be using this room. Turning it off soon.',

  // Panel chrome
  'nav.label': 'Activities',
  'status.off': 'Off',
  'status.starting': 'Starting',
  'status.on': 'On',
  'status.stopping': 'Turning off',
  'status.fault': 'Needs attention',
  'sources.title': 'Show from',
  'source.connected': 'Cable connected',
  'source.disconnected': 'No cable',
  'record.start': 'Start recording',
  'record.stop': 'Stop recording',
  'prompt.accept': 'Switch',
  'prompt.decline': 'Keep current',
  'prompt.seconds': 'Switching in {seconds}s',
  'warning.stay': 'Stay on',
  'warning.seconds': 'Turning off in {seconds}s',
  'volume.label': 'Volume',
  'volume.up': 'Volume up',
  'volume.down': 'Volume down',
  'volume.mute': 'Mute',
  'volume.unmute': 'Unmute',
  'start.title': 'What would you like to do?',
  'activity.running': 'Running',
} as const;

export type TextKey = keyof typeof en;
export type Dictionary = Partial<Record<TextKey, string>>;
export type Translate = (key: TextKey, params?: Record<string, string | number>) => string;

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

export function createTranslator(dictionary: Dictionary = {}): Translate {
  return (key, params) => fill(dictionary[key] ?? en[key], params);
}

/** Engine messages are `{ key, params }`; this turns one into words. */
export function messageText(t: Translate, text: PanelText): string {
  return t(text.key as TextKey, text.params);
}
