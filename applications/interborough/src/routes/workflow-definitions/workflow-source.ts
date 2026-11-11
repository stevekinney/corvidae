/**
 * What the Code tab says about a workflow file's text: where a JSON syntax error is, so the line it
 * belongs to can be marked, and where the parts of the file start, so the outline beside it can
 * jump there. Plain functions over text.
 *
 * The error is found by reading the text here and never from `JSON.parse`'s message, which words
 * the problem differently in every engine (Bun, Chromium and Firefox disagree on whether it names a
 * position at all), so the same file marks the same line wherever the page runs.
 */
import { WORKFLOW_COPY } from '../../app/copy.ts';

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
  const failure = findJsonError(text);
  if (failure === null) return null;
  const stoppedAt = lineAt(text, failure.offset);
  let previous = Math.min(failure.offset, text.length) - 1;
  while (previous > 0 && WHITESPACE.has(text.charAt(previous))) previous -= 1;
  const line = failure.offset >= text.length || previous < 0 ? stoppedAt : lineAt(text, previous);
  const next = text.charAt(failure.offset);
  const comma = failure.afterValue && next !== '' && next !== '}' && next !== ']' && next !== ':';
  return { line, stoppedAt, kind: comma ? 'comma' : 'other' };
}

/**
 * The sentence that opens the banner of a file that cannot load. A file whose JSON is broken and
 * whose problem can be placed names the line the parser stopped at, and says "expected a comma"
 * when a comma was left out; any other problem says the Bureau's own words after the file's name.
 */
export function problemSentence(
  fileName: string,
  problem: { readonly message: string },
  located: JsonProblem | null,
): string {
  const copy = WORKFLOW_COPY.page.problem;
  if (located === null) return copy.unlocated(fileName, problem.message);
  const reason = located.kind === 'comma' ? copy.expectedComma : problem.message.replace(/\.$/, '');
  return copy.located(fileName, located.stoppedAt, reason);
}

/** The note drawn under the line a broken file is marked on. */
export function problemNote(located: JsonProblem): {
  readonly line: number;
  readonly message: string;
} {
  const copy = WORKFLOW_COPY.page.problem;
  return {
    line: located.line,
    message:
      located.kind === 'comma'
        ? copy.missingComma(located.stoppedAt)
        : copy.stopped(located.stoppedAt),
  };
}

/** A part of the file the outline points at. */
export type OutlineEntry = {
  /** The key as a person reads it: `inputSchema` is "input". */
  readonly label: string;
  /** The one-based line it starts on. */
  readonly line: number;
  readonly children: readonly OutlineEntry[];
};

/** The top-level keys the outline names, and what it calls them. */
const OUTLINE_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  title: 'title',
  trigger: 'trigger',
  inputSchema: 'input',
  outputSchema: 'output',
  steps: 'steps',
};

const TOP_LEVEL_KEY = /^ {2}"([^"\\]+)":/;
const STEPS_END = /^ {2}\]/;
const STEP_START = /^ {4}\{/;

/**
 * The outline of a workflow file written the way the Bureau and the builder write it: one key to a
 * line, two spaces in. Each of name, title, trigger, input, output and steps that the file has is
 * an entry, and the steps have an entry apiece, labelled with the number and the step's title. A
 * file written any other way has no outline, because its lines say nothing about its parts.
 */
export function sourceOutline(text: string, stepTitles: readonly string[]): OutlineEntry[] {
  const lines = text.split('\n');
  const entries: OutlineEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const key = TOP_LEVEL_KEY.exec(lines.at(index) ?? '')?.[1];
    if (key === undefined || !Object.hasOwn(OUTLINE_KEYS, key)) continue;
    const children: OutlineEntry[] = [];
    if (key === 'steps') {
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const line = lines.at(inner) ?? '';
        if (STEPS_END.test(line)) break;
        if (!STEP_START.test(line)) continue;
        const position = children.length + 1;
        const title = stepTitles[position - 1] ?? WORKFLOW_COPY.page.steps.untitled(position);
        children.push({ label: `${String(position)} ${title}`, line: inner + 1, children: [] });
      }
    }
    entries.push({ label: OUTLINE_KEYS[key] ?? key, line: index + 1, children });
  }
  return entries;
}

/** The `id` the line of a file's source takes, which the outline links to. */
export function sourceLineId(line: number): string {
  return `workflow-source-line-${String(line)}`;
}
