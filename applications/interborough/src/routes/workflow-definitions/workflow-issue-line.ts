/**
 * The line of a workflow file's text that a Bureau issue names (COR-2432, board
 * PageWorkflowBuilder, "JSON tab, valid JSON but not a valid workflow", row 65z): the Bureau answers
 * a document it refuses with issue paths ("steps[2].duration", "trigger"), and the JSON tab marks the
 * line the path starts on, the footer says "Fix line 21 to return to the builder.", and Create
 * takes the person there. Plain functions over text that parses, read here rather than through
 * `JSON.parse`, which keeps no positions.
 */
import { HttpClientError } from '@lostgradient/weft';

import type { WorkflowValidation } from '../../lib/workflow-files.ts';

/** A line of a document that parses but is not a valid workflow, and what is wrong there. */
export type DocumentProblem = { readonly line: number; readonly message: string };

/** One issue as the Bureau names it: a path in either form, and its message. */
type DocumentIssue = {
  readonly path: string | readonly (string | number)[];
  readonly message: string;
};

/** The Bureau's message as a sentence: a capital first letter and a full stop. */
function sentence(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') return trimmed;
  const capital = `${trimmed.charAt(0).toLocaleUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** The first issue the text holds a line for, as the JSON tab marks it; `undefined` when none does. */
function documentProblemOf(
  text: string,
  issues: readonly DocumentIssue[],
): DocumentProblem | undefined {
  for (const issue of issues) {
    const line = lineOfIssue(text, issuePathOf(issue.path));
    if (line !== undefined) return { line, message: sentence(issue.message) };
  }
  return undefined;
}

/** The issues of an `InvalidParams` fault, which names the draft's keys the operation refused. */
function refusedIssues(error: unknown): DocumentIssue[] | undefined {
  if (!(error instanceof HttpClientError) || error.data?.['weftCode'] !== 'InvalidParams') {
    return undefined;
  }
  const issues = error.data['issues'];
  if (!Array.isArray(issues)) return undefined;
  return (issues as unknown[]).flatMap((issue): DocumentIssue[] => {
    if (typeof issue !== 'object' || issue === null) return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') return [];
    if (typeof path === 'string') return [{ path, message }];
    if (Array.isArray(path)) {
      return [
        {
          path: (path as unknown[]).map((part) => (typeof part === 'number' ? part : String(part))),
          message,
        },
      ];
    }
    return [];
  });
}

/**
 * What the Bureau's checks say of `text` (`ask` is `bureau.workflows.validate` for its draft): the
 * line it refused, from a refusal with issues or an `InvalidParams` fault that names the draft's
 * keys. `undefined` when it would be written, or when the check could not be made, which leaves the
 * write itself to say what is wrong.
 */
export async function documentProblemFor(
  text: string,
  ask: () => Promise<WorkflowValidation>,
): Promise<DocumentProblem | undefined> {
  try {
    const answer = await ask();
    return answer.status === 'invalid' ? documentProblemOf(text, answer.issues) : undefined;
  } catch (error) {
    const issues = refusedIssues(error);
    return issues === undefined ? undefined : documentProblemOf(text, issues);
  }
}

/** A path's parts: object keys, and array positions as numbers. */
type IssuePath = readonly (string | number)[];

/**
 * The parts of an issue path, in either form the Bureau answers: a dotted path with positions in
 * brackets (`steps[2].input.message`, a leading `$.` allowed), or a list of keys and positions.
 * A list that starts with `definition` (an operation's own parameter) drops it.
 */
function issuePathOf(path: string | readonly (string | number)[]): IssuePath {
  const parts: (string | number)[] =
    typeof path === 'string'
      ? path
          .replace(/^\$\.?/, '')
          .split(/[.[\]/]+/)
          .filter((part) => part !== '')
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [...path];
  return parts[0] === 'definition' ? parts.slice(1) : parts;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipWhitespace(text: string, at: number): number {
  let index = at;
  while (index < text.length && WHITESPACE.has(text.charAt(index))) index += 1;
  return index;
}

/** The offset after the string that starts at `at` (its opening quote), and its value. */
function readString(text: string, at: number): { end: number; value: string } {
  let index = at + 1;
  let value = '';
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === '\\') {
      value += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') return { end: index + 1, value };
    value += character;
    index += 1;
  }
  return { end: index, value };
}

/** The offset after the value that starts at `at`. */
function skipValue(text: string, at: number): number {
  const first = text.charAt(at);
  if (first === '"') return readString(text, at).end;
  if (first === '{' || first === '[') {
    let depth = 0;
    let index = at;
    while (index < text.length) {
      const character = text.charAt(index);
      if (character === '"') {
        index = readString(text, index).end;
        continue;
      }
      if (character === '{' || character === '[') depth += 1;
      if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return index;
  }
  let index = at;
  while (
    index < text.length &&
    !',}]'.includes(text.charAt(index)) &&
    !WHITESPACE.has(text.charAt(index))
  ) {
    index += 1;
  }
  return index;
}

/**
 * Where the part `part` of the value at `at` starts: a key's own position in an object (so the line
 * named is the key's), or an element's in an array. `undefined` when the value has no such part.
 */
function partOf(
  text: string,
  at: number,
  part: string | number,
): { readonly mark: number; readonly value: number } | undefined {
  const open = text.charAt(at);
  let index = skipWhitespace(text, at + 1);
  if (open === '{') {
    while (index < text.length && text.charAt(index) === '"') {
      const key = readString(text, index);
      const colon = skipWhitespace(text, key.end);
      if (text.charAt(colon) !== ':') return undefined;
      const value = skipWhitespace(text, colon + 1);
      if (key.value === String(part)) return { mark: index, value };
      index = skipWhitespace(text, skipValue(text, value));
      if (text.charAt(index) !== ',') return undefined;
      index = skipWhitespace(text, index + 1);
    }
    return undefined;
  }
  if (open === '[' && typeof part === 'number') {
    for (let position = 0; index < text.length && text.charAt(index) !== ']'; position += 1) {
      if (position === part) return { mark: index, value: index };
      index = skipWhitespace(text, skipValue(text, index));
      if (text.charAt(index) !== ',') return undefined;
      index = skipWhitespace(text, index + 1);
    }
  }
  return undefined;
}

/**
 * The one-based line the deepest part of `path` that the text holds starts on: a path that goes
 * further than the text (a key the step lacks) names the line of the last part that is there, which
 * is where the fix goes. `undefined` for text that is not JSON with an object at its root.
 */
function lineOfIssue(text: string, path: IssuePath): number | undefined {
  let value = skipWhitespace(text, 0);
  if (text.charAt(value) !== '{') return undefined;
  let mark = value;
  for (const part of path) {
    const found = partOf(text, value, part);
    if (found === undefined) break;
    mark = found.mark;
    value = found.value;
  }
  return text.slice(0, mark).split('\n').length;
}
