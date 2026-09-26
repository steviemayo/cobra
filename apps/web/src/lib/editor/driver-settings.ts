import type { DeclaredSetting } from '@kestrel/model';

// Helpers for showing a driver's settings as fields (device card) and as table cells (Setup tab).

export type FieldKind = 'boolean' | 'number' | 'text' | 'json';

/** How a setting is entered: from its declared type, else from the value it has or would start with. */
export function fieldKind(setting: Pick<DeclaredSetting, 'type' | 'default'>, current: unknown): FieldKind {
  const sample = current ?? setting.default;
  if (typeof sample === 'object' && sample !== null) return 'json';
  if (setting.type === 'boolean' || typeof sample === 'boolean') return 'boolean';
  if (setting.type === 'number' || typeof sample === 'number') return 'number';
  return 'text';
}

/**
 * The value to store for what someone typed into a setting, or `undefined` to remove it. A number
 * setting that is not a number is an error, so a typo is not stored as text.
 */
export function parseFieldValue(kind: FieldKind, text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: undefined };
  if (kind === 'number') {
    const n = Number(t);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Enter a number' };
  }
  if (kind === 'boolean') return { ok: true, value: /^(true|yes|on|1)$/i.test(t) };
  if (kind === 'json') {
    try {
      return { ok: true, value: JSON.parse(t) as unknown };
    } catch {
      return { ok: false, message: 'Not valid JSON' };
    }
  }
  return { ok: true, value: text };
}

/** Text pasted from a spreadsheet as rows of cells. A single value with no tab or line break is one cell. */
export function parsePasted(text: string): string[][] {
  const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return rows.map((r) => r.split('\t'));
}

/** Whether pasted text is a block of cells rather than one value. */
export const isBlockPaste = (text: string) => /[\t\n]/.test(text.replace(/\r?\n$/, ''));
