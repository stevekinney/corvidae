/**
 * Locating the first syntax problem in JSON source.
 *
 * `JSON.parse` says that source is invalid, but not where: V8 reports a character position,
 * Firefox a line and column, and JavaScriptCore (Safari and Bun) nothing at all. This module owns
 * the location, with a small strict-JSON scanner that stops at the first problem, so the line the
 * editor marks does not depend on the engine running it.
 *
 * The scanner also decides where a problem is _anchored_. A missing separator is noticed when the
 * parser reaches the token after the gap, which is often on the next line, but the line a person
 * has to fix is the one that ends without its comma. For a missing comma or colon the anchor is
 * the last token before the position where the parser stopped.
 */

/** What kind of mistake the scanner found. */
export type JsonProblemKind =
  | 'comma'
  | 'colon'
  | 'name'
  | 'value'
  | 'trailing-comma'
  | 'end'
  | 'token'
  | 'string'
  | 'number'
  | 'extra';

/** The first syntax problem in a JSON source, located at the line a person has to fix. */
export interface JsonProblem {
  /** What kind of mistake it is. */
  kind: JsonProblemKind;
  /** The offset of the character the problem is anchored to. */
  position: number;
  /** The offset where the parser stopped, which differs from `position` for a missing separator. */
  parserPosition: number;
  /** The one-based line of `position`. */
  line: number;
  /** A short clause that completes "Line 2: …", such as `expected a comma`. */
  summary: string;
  /** A sentence to show at the line itself, such as `Missing comma at the end of this line.`. */
  detail: string;
}

class ScanFailure extends Error {
  constructor(
    readonly kind: JsonProblemKind,
    readonly parserPosition: number,
  ) {
    super(kind);
  }
}

const whitespace = new Set([' ', '\t', '\n', '\r']);
const escapes = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const hexadecimalPattern = /^[0-9a-fA-F]{4}$/;
const literals = ['true', 'false', 'null'] as const;

/** Scan `source` as strict JSON and throw a `ScanFailure` at the first problem. */
function scan(source: string): void {
  let position = 0;

  const skipWhitespace = (): void => {
    while (position < source.length && whitespace.has(source.charAt(position))) position += 1;
  };

  const scanString = (): void => {
    position += 1;
    for (;;) {
      if (position >= source.length) throw new ScanFailure('string', source.length);
      const character = source.charAt(position);
      if (character === '"') {
        position += 1;
        return;
      }
      if (character < ' ') throw new ScanFailure('string', position);
      if (character === '\\') {
        const escape = source.charAt(position + 1);
        if (escape === 'u') {
          if (!hexadecimalPattern.test(source.slice(position + 2, position + 6))) {
            throw new ScanFailure('token', position);
          }
          position += 6;
        } else if (escapes.has(escape)) {
          position += 2;
        } else {
          throw new ScanFailure('token', position);
        }
      } else {
        position += 1;
      }
    }
  };

  const scanValue = (): void => {
    skipWhitespace();
    if (position >= source.length) throw new ScanFailure('end', source.length);
    const character = source.charAt(position);
    if (character === '{') return scanObject();
    if (character === '[') return scanArray();
    if (character === '"') return scanString();
    if (character === '-' || (character >= '0' && character <= '9')) {
      numberPattern.lastIndex = position;
      const match = numberPattern.exec(source);
      if (match === null) throw new ScanFailure('number', position);
      const next = source.charAt(position + match[0].length);
      if (next === '.' || (next >= '0' && next <= '9') || next === 'e' || next === 'E') {
        throw new ScanFailure('number', position);
      }
      position += match[0].length;
      return;
    }
    if (character === ',' || character === ']' || character === '}' || character === ':') {
      throw new ScanFailure('value', position);
    }
    const literal = literals.find((candidate) => source.startsWith(candidate, position));
    if (literal === undefined) throw new ScanFailure('token', position);
    position += literal.length;
  };

  const scanObject = (): void => {
    position += 1;
    skipWhitespace();
    if (source.charAt(position) === '}') {
      position += 1;
      return;
    }
    let afterComma = false;
    for (;;) {
      skipWhitespace();
      if (position >= source.length) throw new ScanFailure('end', source.length);
      if (source.charAt(position) !== '"') {
        throw new ScanFailure(
          source.charAt(position) === '}' && afterComma ? 'trailing-comma' : 'name',
          position,
        );
      }
      scanString();
      skipWhitespace();
      if (position >= source.length) throw new ScanFailure('end', source.length);
      if (source.charAt(position) !== ':') throw new ScanFailure('colon', position);
      position += 1;
      scanValue();
      skipWhitespace();
      if (position >= source.length) throw new ScanFailure('end', source.length);
      const separator = source.charAt(position);
      if (separator === '}') {
        position += 1;
        return;
      }
      if (separator !== ',') throw new ScanFailure('comma', position);
      position += 1;
      afterComma = true;
    }
  };

  const scanArray = (): void => {
    position += 1;
    skipWhitespace();
    if (source.charAt(position) === ']') {
      position += 1;
      return;
    }
    let afterComma = false;
    for (;;) {
      skipWhitespace();
      if (afterComma && source.charAt(position) === ']') {
        throw new ScanFailure('trailing-comma', position);
      }
      scanValue();
      skipWhitespace();
      if (position >= source.length) throw new ScanFailure('end', source.length);
      const separator = source.charAt(position);
      if (separator === ']') {
        position += 1;
        return;
      }
      if (separator !== ',') throw new ScanFailure('comma', position);
      position += 1;
      afterComma = true;
    }
  };

  scanValue();
  skipWhitespace();
  if (position < source.length) throw new ScanFailure('extra', position);
}

/** The offset of the last character that is not whitespace before `before`, or 0 when there is none. */
function lastTokenBefore(source: string, before: number): number {
  let index = Math.min(before, source.length) - 1;
  while (index > 0 && whitespace.has(source.charAt(index))) index -= 1;
  return Math.max(0, index);
}

/** The one-based line that holds the character at `offset`. */
export function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charAt(index) === '\n') line += 1;
  }
  return line;
}

/** Whether only whitespace follows `offset` on its own line. */
function endsItsLine(source: string, offset: number): boolean {
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === '\n') return true;
    if (!whitespace.has(character)) return false;
  }
  return true;
}

function describe(kind: JsonProblemKind, source: string, position: number, parserPosition: number) {
  const character = source.charAt(parserPosition);
  switch (kind) {
    case 'comma':
      return {
        summary: 'expected a comma',
        detail: endsItsLine(source, position)
          ? 'Missing comma at the end of this line.'
          : 'Missing comma after this value.',
      };
    case 'colon':
      return {
        summary: 'expected a colon',
        detail: 'Missing colon after this property name.',
      };
    case 'name':
      return {
        summary: 'expected a property name in double quotes',
        detail: 'A property name must be a string in double quotes.',
      };
    case 'value':
      return { summary: 'expected a value', detail: 'Expected a value here.' };
    case 'trailing-comma':
      return { summary: 'remove the trailing comma', detail: 'Remove the trailing comma.' };
    case 'end':
      return {
        summary: 'unexpected end of the JSON',
        detail: 'The JSON ends before it is complete.',
      };
    case 'string':
      return { summary: 'unterminated string', detail: 'This string is not closed.' };
    case 'number':
      return { summary: 'invalid number', detail: 'This is not a valid JSON number.' };
    case 'extra':
      return {
        summary: 'unexpected content after the JSON',
        detail: 'Nothing can follow the JSON value.',
      };
    case 'token':
      return {
        summary: character === '' ? 'unexpected token' : `unexpected ${character}`,
        detail: character === '' ? 'Unexpected token.' : `Unexpected ${character} here.`,
      };
  }
}

/**
 * Locate the first syntax problem in JSON source.
 *
 * Returns `undefined` when the source is empty or is valid JSON. The result is anchored where a
 * person has to fix it: a missing comma or colon sits at the end of the last token before the
 * place the parser stopped, and a trailing comma sits on the comma.
 */
export function locateJsonProblem(source: string): JsonProblem | undefined {
  if (source.trim() === '') return undefined;
  try {
    JSON.parse(source);
    return undefined;
  } catch {
    // Invalid. The scan below says where; a scan that finds nothing falls through to the last
    // token, so a disagreement between the two never hides a real problem.
  }
  let kind: JsonProblemKind = 'token';
  let parserPosition = lastTokenBefore(source, source.length);
  try {
    scan(source);
  } catch (error) {
    if (error instanceof ScanFailure) {
      kind = error.kind;
      parserPosition = error.parserPosition;
    }
    // A RangeError from very deep nesting falls back to the last token as well.
  }
  const anchoredBefore =
    kind === 'comma' || kind === 'colon' || kind === 'trailing-comma' || kind === 'end';
  const position = anchoredBefore
    ? lastTokenBefore(source, parserPosition)
    : Math.min(parserPosition, Math.max(0, source.length - 1));
  const { summary, detail } = describe(kind, source, position, parserPosition);
  return {
    kind,
    position,
    parserPosition,
    line: lineOfOffset(source, position),
    summary,
    detail,
  };
}
