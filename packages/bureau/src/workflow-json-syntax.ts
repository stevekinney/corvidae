/** Where a file's JSON stops being JSON, and what the parser was waiting for. */
export type JsonProblem = {
  /** The one-based line to mark: the line the last good value ended on. */
  readonly line: number;
  /** The one-based line the parser stopped at, which is the line after `line` for a comma left out. */
  readonly stoppedAt: number;
  /** `comma` when a value was complete and the next token began without a comma between them. */
  readonly kind: 'comma' | 'other';
};

type Failure = { readonly offset: number; readonly afterValue: boolean };

/** Ends the scan at the first place the text stops being JSON, carrying where that is. */
class JsonStop extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super('The text stops being JSON here.');
    this.failure = failure;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ['true', 'false', 'null'] as const;

/**
 * Reads `text` as one JSON value and returns where it first stops being JSON, or `null` when it is
 * valid. `afterValue` says the parser had just finished a value and wanted a comma or a closing
 * bracket.
 */
function findJsonError(text: string): Failure | null {
  let index = 0;

  const fail = (afterValue = false): never => {
    throw new JsonStop({ offset: index, afterValue });
  };
  const skip = (): void => {
    while (index < text.length && WHITESPACE.has(text.charAt(index))) index += 1;
  };

  function string(): void {
    index += 1;
    while (index < text.length) {
      const character = text.charAt(index);
      if (character === '"') {
        index += 1;
        return;
      }
      if (character === '\\') index += 2;
      else if (character < ' ') fail();
      else index += 1;
    }
    fail();
  }

  function number(): void {
    NUMBER.lastIndex = index;
    const found = NUMBER.exec(text);
    if (found === null) fail();
    else index += found[0].length;
  }

  function members(close: '}' | ']', member: () => void): void {
    index += 1;
    skip();
    if (text.charAt(index) === close) {
      index += 1;
      return;
    }
    for (;;) {
      skip();
      member();
      skip();
      const next = text.charAt(index);
      if (next === ',') {
        index += 1;
        continue;
      }
      if (next === close) {
        index += 1;
        return;
      }
      fail(true);
    }
  }

  function value(): void {
    skip();
    const character = text.charAt(index);
    if (character === '{') {
      members('}', () => {
        if (text.charAt(index) !== '"') fail();
        string();
        skip();
        if (text.charAt(index) !== ':') fail();
        index += 1;
        value();
      });
      return;
    }
    if (character === '[') {
      members(']', value);
      return;
    }
    if (character === '"') {
      string();
      return;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      number();
      return;
    }
    for (const literal of LITERALS) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    fail();
  }

  try {
    value();
    skip();
    // Anything after the one value is not a missing comma: a file holds one value.
    if (index < text.length) fail();
    return null;
  } catch (error) {
    if (error instanceof JsonStop) return error.failure;
    throw error;
  }
}

/** The one-based line an offset of `text` is on. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let position = 0; position < offset && position < text.length; position += 1) {
    if (text.charAt(position) === '\n') line += 1;
  }
  return line;
}

/**
 * Where the text stops being JSON, or `null` when it parses. The line to mark is the one the last
 * complete token ended on, because a parser that wanted a comma reports the line after it, and the
 * missing character is at the end of the line before.
 */
export function locateJsonProblem(text: string): JsonProblem | null {
  let failure: Failure | null;
  try {
    failure = findJsonError(text);
  } catch (error) {
    // The engine can reject an invalid file nested more deeply than the diagnostic scanner.
    if (error instanceof RangeError) return null;
    throw error;
  }
  if (failure === null) return null;
  const stoppedAt = lineAt(text, failure.offset);
  let previous = Math.min(failure.offset, text.length) - 1;
  while (previous > 0 && WHITESPACE.has(text.charAt(previous))) previous -= 1;
  const line = failure.offset >= text.length || previous < 0 ? stoppedAt : lineAt(text, previous);
  const next = text.charAt(failure.offset);
  const comma = failure.afterValue && next !== '' && next !== '}' && next !== ']' && next !== ':';
  return { line, stoppedAt, kind: comma ? 'comma' : 'other' };
}
