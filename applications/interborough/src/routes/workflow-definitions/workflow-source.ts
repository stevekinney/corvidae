/**
 * The Code tab's presentation of a workflow file's source diagnostic and outline.
 */
import type { JsonProblem } from '@lostgradient/bureau/workflow-json';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';

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
