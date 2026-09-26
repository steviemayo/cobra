import { describe, expect, it } from 'vitest';
import { fieldKind, isBlockPaste, parseFieldValue, parsePasted } from './driver-settings';

describe('how a setting is entered', () => {
  it('follows the declared type, else the value it has or starts with', () => {
    expect(fieldKind({ type: 'number' }, undefined)).toBe('number');
    expect(fieldKind({ type: 'boolean' }, undefined)).toBe('boolean');
    expect(fieldKind({}, 30)).toBe('number');
    expect(fieldKind({ default: true }, undefined)).toBe('boolean');
    expect(fieldKind({ default: { Wide: 0 } }, undefined)).toBe('json');
    expect(fieldKind({}, [1])).toBe('json');
    expect(fieldKind({ type: 'string' }, undefined)).toBe('text');
  });
});

describe('what was typed into a setting', () => {
  it('is nothing when empty', () => {
    expect(parseFieldValue('text', '  ')).toEqual({ ok: true, value: undefined });
  });
  it('turns a number into a number and refuses a typo', () => {
    expect(parseFieldValue('number', ' 42 ')).toEqual({ ok: true, value: 42 });
    expect(parseFieldValue('number', '4x')).toEqual({ ok: false, message: 'Enter a number' });
  });
  it('reads JSON and says when it is not', () => {
    expect(parseFieldValue('json', '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseFieldValue('json', '{a')).toEqual({ ok: false, message: 'Not valid JSON' });
  });
  it('keeps text exactly as typed', () => {
    expect(parseFieldValue('text', ' a b ')).toEqual({ ok: true, value: ' a b ' });
  });
});

describe('pasting from a spreadsheet', () => {
  it('splits rows and cells', () => {
    expect(parsePasted('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('treats one value as an ordinary paste', () => {
    expect(isBlockPaste('10.0.0.5')).toBe(false);
    expect(isBlockPaste('10.0.0.5\n')).toBe(false);
    expect(isBlockPaste('10.0.0.5\n10.0.0.6')).toBe(true);
    expect(isBlockPaste('a\tb')).toBe(true);
  });
});
