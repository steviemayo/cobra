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
  'session.connecting': 'Connecting to the room…',
  'session.reconnecting': 'Reconnecting to the room…',
  'session.error': 'This panel can’t reach the room right now.',
  'phone.button': 'Control from your phone',
  'phone.title': 'Scan with your phone’s camera to control this room.',
  'phone.close': 'Close',
  'pin.title': 'Enter PIN',
  'pin.submit': 'Unlock',
  'pin.clear': 'Clear',
  'idle.begin': 'Touch to begin',
  'idle.support': 'Need support?',
  'volume.muted': 'Muted',
  'quick.more': 'Quick actions',
  'linking.button': 'Link rooms',
  'linking.title': 'Link rooms',
  'linking.space': 'Linked together: {rooms}',
  'linking.alone': 'This room is on its own.',
  'linking.none': 'There are no rooms to link with here.',
  'linking.option.combine': 'Combine with {rooms}',
  'linking.option.link': 'Link {rooms}',
  'linking.linked': 'Linked with {rooms}',
  'linking.combine': 'Combine',
  'linking.separate': 'Separate',
  'linking.unavailable': 'Not set up yet',
  'linking.confirm.combine': 'Combine with {rooms}?',
  'linking.confirm.combine.body': 'Their screens, sound and controls will work together as one.',
  'linking.confirm.separate': 'Separate from {rooms}?',
  'linking.confirm.separate.body': 'Each room will work on its own again.',
  'quick.display.blank': 'Blank Screen',
  'quick.mics.privacy_mute': 'Privacy Mute',
  'sheet.close': 'Close',
  'power.button': 'Power',
  'power.title': 'Power off system?',
  'power.body': 'The displays and audio will turn off.',
  'power.confirm': 'Power off',
  'power.cancel': 'Cancel',
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
