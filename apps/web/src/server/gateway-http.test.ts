import { describe, expect, it } from 'vitest';
import { readJson } from './gateway-http';

function requestWith(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://x/', { method: 'POST', body, headers });
}

describe('readJson', () => {
  it('parses an ordinary body', async () => {
    expect(await readJson(requestWith('{"a":1}'))).toEqual({ a: 1 });
  });

  it('returns undefined for a body that is not valid JSON', async () => {
    expect(await readJson(requestWith('not json'))).toBeUndefined();
  });

  it('returns undefined for a request with no body', async () => {
    expect(await readJson(new Request('http://x/'))).toBeUndefined();
  });

  it('is bounded by the bytes actually sent, not by a content-length header', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(1000) });
    // A claimed size far smaller than what is really sent must not let it through.
    const lying = requestWith(big, { 'content-length': '5' });
    expect(await readJson(lying, 100)).toBeUndefined();
    // The same body is read in full, and accepted, once the limit actually covers it.
    expect(await readJson(requestWith(big, { 'content-length': '5' }), 10_000)).toEqual({
      a: 'x'.repeat(1000),
    });
  });

  it('accepts a body right at the limit and refuses one byte over it', async () => {
    const exact = JSON.stringify({ a: 'x'.repeat(90) }); // tuned to land on the limit below
    const limit = exact.length;
    expect(await readJson(requestWith(exact), limit)).toEqual({ a: 'x'.repeat(90) });
    const over = JSON.stringify({ a: 'x'.repeat(91) });
    expect(await readJson(requestWith(over), limit)).toBeUndefined();
  });
});
