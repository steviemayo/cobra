import { describe, expect, it } from 'vitest';
import { en } from './i18n';
import { ENGLISH_KEYS, LANGUAGES, translatorFor } from './languages';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('language packs', () => {
  it('translate every string, so nothing silently falls back to English', () => {
    for (const [code, { dictionary }] of Object.entries(LANGUAGES)) {
      if (code === 'en') continue;
      expect(Object.keys(dictionary).sort(), code).toEqual([...ENGLISH_KEYS].sort());
    }
  });

  it('keep the placeholders the engine fills in', () => {
    for (const [code, { dictionary }] of Object.entries(LANGUAGES))
      for (const [key, text] of Object.entries(dictionary))
        expect(placeholders(text as string), `${code}:${key}`).toEqual(
          placeholders(en[key as keyof typeof en]),
        );
  });

  it('picks a pack from a language code, ignoring region and case', () => {
    expect(translatorFor('es')('volume.label')).toBe('Volumen');
    expect(translatorFor('FR-ca')('volume.label')).toBe('Volume');
    expect(translatorFor('de_AT')('start.title')).toBe('Was möchten Sie tun?');
  });

  it('falls back to English for an unknown or missing language', () => {
    expect(translatorFor('xx')('volume.label')).toBe('Volume');
    expect(translatorFor(undefined)('start.title')).toBe(en['start.title']);
    expect(translatorFor('es')('presenting', { source: 'Portátil 1' })).toBe(
      'Mostrando Portátil 1.',
    );
  });
});
