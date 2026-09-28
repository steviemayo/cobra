// A driver's regular expressions run against text a real device sends back, on the single event
// loop that runs every room on a gateway (up to ~50 of them). A pattern with catastrophic
// backtracking — a repeated group that itself contains another unbounded repetition, such as
// `(a+)+` or `(.*)*` — can take exponential time on a line that almost, but does not quite,
// match, freezing the gateway process. `new RegExp(source)` only checks that the syntax is valid;
// it says nothing about how long it can take to run. This is a small, deliberately conservative
// scanner for that one dangerous shape, so a driver with it is rejected at save time rather than
// discovered on a real device.
//
// It is not a full analysis (it does not reason about which characters two branches of an
// alternation can each match), so it can reject a pattern that would actually run fine — a driver
// author is asked to write it a different way, which is a small cost next to a gateway that can
// stop responding to every room it hosts. It never has false negatives for the classic shapes
// (nested `+`/`*`/unbounded `{n,}`), which are what real accidental ReDoS looks like.

/** Index one past the `]` that closes a character class starting at `source[open]` (`'['`). */
function skipCharClass(source: string, open: number): number {
  let i = open + 1;
  if (source[i] === '^') i++;
  if (source[i] === ']') i++; // a leading ] (or [^]) is a literal, not the close
  while (i < source.length && source[i] !== ']') {
    i += source[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

/** Index one past the group that opens at `source[open]` (`'('`), skipping nested groups and classes. */
function skipGroup(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === '[') i = skipCharClass(source, i);
    else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else i++;
  }
  return i;
}

/** Whether `source[at]` (just past an atom or a group) is a quantifier with no fixed upper bound. */
function unboundedQuantifierAt(source: string, at: number): { yes: boolean; end: number } {
  const c = source[at];
  if (c === '*' || c === '+') {
    const end = source[at + 1] === '?' ? at + 2 : at + 1; // a lazy modifier changes nothing here
    return { yes: true, end };
  }
  if (c === '{') {
    const close = source.indexOf('}', at);
    if (close === -1) return { yes: false, end: at };
    const body = source.slice(at + 1, close);
    // {n} is an exact count: repeating a loop a fixed number of times is polynomial, not
    // exponential, even when nested, so only an open-ended {n,} (or {n,m}) counts as unbounded.
    const m = /^(\d+)(,(\d+)?)?$/.exec(body);
    if (!m) return { yes: false, end: at };
    const end = source[close + 1] === '?' ? close + 2 : close + 1;
    return { yes: m[2] !== undefined && m[3] === undefined, end };
  }
  return { yes: false, end: at };
}

/** The index just past a group's opening `(`, `(?:`, `(?<name>`, `(?=`, `(?!`, `(?<=` or `(?<!`. */
function groupBodyStart(source: string, open: number): number {
  if (source[open + 1] !== '?') return open + 1;
  const c2 = source[open + 2];
  if (c2 === ':' || c2 === '=' || c2 === '!') return open + 3;
  if (c2 === '<') {
    if (source[open + 3] === '=' || source[open + 3] === '!') return open + 4; // lookbehind
    const close = source.indexOf('>', open + 3); // named group (?<name>...)
    return close === -1 ? open + 3 : close + 1;
  }
  return open + 1;
}

/** True if `source.slice(from, to)` contains any atom or group with an unbounded quantifier. */
function containsUnboundedRepeat(source: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const c = source[i];
    if (c === '\\') {
      const end = i + 2;
      const q = unboundedQuantifierAt(source, end);
      if (q.yes) return true;
      i = q.end > end ? q.end : end;
      continue;
    }
    if (c === '[') {
      const end = skipCharClass(source, i);
      const q = unboundedQuantifierAt(source, end);
      if (q.yes) return true;
      i = q.end > end ? q.end : end;
      continue;
    }
    if (c === '(') {
      const end = skipGroup(source, i);
      const q = unboundedQuantifierAt(source, end);
      if (q.yes) return true;
      i = q.end > end ? q.end : end;
      continue;
    }
    const q = unboundedQuantifierAt(source, i + 1);
    if (q.yes) return true;
    i = q.end > i + 1 ? q.end : i + 1;
  }
  return false;
}

/**
 * Splits `body` on its top-level `|` (one not inside a nested group or class). A branch that uses
 * any metacharacter is reported as `null`: this function only ever draws a conclusion from plain
 * literal branches, so it can never misjudge one it does not understand.
 */
function topLevelAlternatives(body: string): (string | null)[] {
  const parts: (string | null)[] = [];
  let start = 0;
  let sawMeta = false;
  let i = 0;
  const flush = (end: number) => {
    parts.push(sawMeta ? null : body.slice(start, end));
    sawMeta = false;
    start = end + 1;
  };
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      sawMeta = true;
      i += 2;
      continue;
    }
    if (c === '[') {
      sawMeta = true;
      i = skipCharClass(body, i);
      continue;
    }
    if (c === '(') {
      sawMeta = true;
      i = skipGroup(body, i);
      continue;
    }
    if ('.*+?^${}'.includes(c!)) sawMeta = true;
    if (c === '|') {
      flush(i);
      i++;
      continue;
    }
    i++;
  }
  flush(body.length);
  return parts;
}

/**
 * True if a repeated group's alternatives can each match the same text in more than one way, such
 * as `(a|a)*` or `(a|ab)*`: the classic case is one plain-literal branch that is a prefix of (or
 * equal to) another, which lets the engine try many different ways of splitting the same run of
 * input across loop iterations. Only literal branches are compared (see `topLevelAlternatives`),
 * so a branch built from other metacharacters is simply not a reason to flag it as unsafe here.
 */
function hasAmbiguousAlternation(body: string): boolean {
  const parts = topLevelAlternatives(body).filter((p): p is string => p !== null && p.length > 0);
  for (let i = 0; i < parts.length; i++)
    for (let j = 0; j < parts.length; j++)
      if (i !== j && parts[j]!.startsWith(parts[i]!)) return true;
  return false;
}

/**
 * True if the pattern has a group repeated with no upper bound (`+`, `*`, or `{n,}`) whose own
 * body contains another unbounded repetition, or whose alternatives are ambiguous — the shapes
 * behind catastrophic backtracking (`(a+)+`, `(a*)*`, `(a|a)*`, `(.*)+`, and so on, however they
 * are spelled or nested).
 */
export function hasCatastrophicBacktracking(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      i = skipCharClass(source, i);
      continue;
    }
    if (c === '(') {
      const close = skipGroup(source, i); // one past the matching ')'
      const q = unboundedQuantifierAt(source, close);
      if (q.yes) {
        const bodyStart = groupBodyStart(source, i);
        const body = source.slice(bodyStart, close - 1);
        if (containsUnboundedRepeat(source, bodyStart, close - 1) || hasAmbiguousAlternation(body))
          return true;
      }
      i = q.yes ? q.end : close;
      continue;
    }
    i++;
  }
  return false;
}
