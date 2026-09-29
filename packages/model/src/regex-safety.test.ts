import { describe, expect, it } from 'vitest';
import { hasCatastrophicBacktracking } from './regex-safety';

// Proven against the real regex engine once, by hand, rather than by timing it in every run: how
// long `(a+)+$` takes against 27 a's swung from about a second in isolation to over ten seconds
// next to the rest of the workspace's test suites, which is exactly the kind of
// environment-dependent flakiness this project avoids elsewhere (the panel-server test note in
// docs/plan.md). `^POWER=(ON|OFF)$` and `\d{2,4}` against 20,000 a's stayed under a millisecond.
// The tests below are the durable proof: every named catastrophic shape is caught, and every
// pattern already in use in the driver library is not.
describe('hasCatastrophicBacktracking', () => {
  it('catches the textbook shapes, however they are grouped or spelled', () => {
    const bad = [
      '(a+)+',
      '(a+)*',
      '(a*)+',
      '(a*)*',
      '(.*)*',
      '(.*)+',
      '(\\d+)+',
      '([a-z]+)+',
      '(a|a)*',
      '(a|ab)*',
      '(?:a+)+',
      '(?<x>a+)+',
      '((a+)+)+',
      '(a+){2,}',
      '(a*){5,}',
      '(a+)+$',
      '^(a+)+',
      'x(a+)+y',
    ];
    for (const source of bad) expect(hasCatastrophicBacktracking(source), source).toBe(true);
  });

  it('lets ordinary device-reply patterns through, including ones already in the driver library', () => {
    const good = [
      '^OK$',
      '^POWER=(ON|OFF)$',
      '^VOL=(-?\\d+)$',
      '^FW=(.+)$',
      '"status"\\s*:\\s*"active"',
      '<State[^>]*>Standby</State>',
      '~OUTPUT,\\d+,1,(\\d+(?:\\.\\d+)?)',
      '^\\s*a \\d+ OK01\\s*$',
      '@ROUTE\\s+\\d+,',
      '"on":(true|false)',
      'Healthy',
      '\\d{2,4}',
      '[A-Za-z0-9_-]{1,40}',
      'a+',
      '(ab)+',
      '(a+)(b+)',
      '(a+)b(c+)',
      '(?:ab)+',
      'a{3}',
      '(a{3})+', // an exact-count inner repeat is polynomial, not exponential, even nested
    ];
    for (const source of good) expect(hasCatastrophicBacktracking(source), source).toBe(false);
  });


  it('does not choke on the input it is checking, however it is written', () => {
    for (const source of ['(', ')', '[', '\\', '(?<', '{', '', 'a'.repeat(2000), '(((((((((('])
      expect(() => hasCatastrophicBacktracking(source)).not.toThrow();
  });

  it('is not confused by parentheses or quantifier characters inside a character class', () => {
    expect(hasCatastrophicBacktracking('[()+*]+')).toBe(false);
    expect(hasCatastrophicBacktracking('[a+]+')).toBe(false);
    expect(hasCatastrophicBacktracking('([()]+)+')).toBe(true);
  });
});
