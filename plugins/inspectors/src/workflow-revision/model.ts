/**
 * What the workflow revision review decides without a DOM (COR-2218): the shape of a definition and
 * of the host's answers, the rows that compare the current definition with the proposed one, and
 * the words the page says for each state of the review. The page script reads and writes through
 * the host's bridge; this reads only values.
 */

/** A workflow definition as the host holds it, less its name. */
export type Definition = {
  readonly [key: string]: unknown;
  readonly title?: string;
  readonly description?: string;
  readonly agent?: string;
  readonly paused?: boolean;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly trigger: Record<string, unknown>;
  readonly steps: readonly Record<string, unknown>[];
};

/** A workflow as `bureau.workflows.get` answers: its id, the hash an update is fenced by, and its canonical text. */
export type Workflow = { readonly id: string; readonly hash: string; readonly text: string };

/** Where the review stands, which decides what the page says and which buttons it offers. */
export type RevisionState =
  | 'loading'
  | 'changed'
  | 'no-changes'
  | 'applying'
  | 'applied'
  | 'conflict'
  | 'denied'
  | 'offline'
  | 'unknown'
  | 'retryable';

/** The proposal that opened the page: what the agent proposed, and the hash it was written against. */
export type ProposalResult = {
  readonly status: 'ok';
  readonly id: string;
  readonly baseHash: string;
  readonly proposedText: string;
};

/** How one row of the comparison differs between the current and the proposed definition. */
export type RowState = 'unchanged' | 'added' | 'removed' | 'changed';

/** One row of the comparison: a part of the definition, how it differs, and both values as text. */
export type RevisionRow = {
  /** The part: a field name, `Trigger`, or `Step <n>`. */
  readonly label: string;
  /** How it differs. */
  readonly state: RowState;
  /** The marker the row shows for `state`: its first letter in capitals. */
  readonly marker: string;
  /** The current value as text. */
  readonly current: string;
  /** The proposed value as text. */
  readonly proposed: string;
};

/** Whether `value` is an object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result's structured content, or `undefined` for an error result or one `guard` refuses. */
export function structured<T>(
  result: { structuredContent?: unknown; isError?: boolean | undefined },
  guard: (value: unknown) => value is T,
): T | undefined {
  return result.isError !== true && guard(result.structuredContent)
    ? result.structuredContent
    : undefined;
}

/** What a tool result carries, read from its structured content or, failing that, its first text block as JSON. */
export function structuredResult(value: {
  structuredContent?: unknown;
  content?: unknown;
}): unknown {
  if (typeof value.structuredContent === 'string') {
    try {
      return JSON.parse(value.structuredContent) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value.structuredContent !== undefined) return value.structuredContent;
  if (!Array.isArray(value.content)) return undefined;
  const textBlock = value.content.find(
    (block): block is { readonly text: string } =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string',
  );
  if (textBlock === undefined) return undefined;
  try {
    return JSON.parse(textBlock.text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether `value` is a workflow as `bureau.workflows.get` answers. */
export function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'hash') === 'string' &&
    typeof Reflect.get(value, 'text') === 'string'
  );
}

/** Whether `value` is the outcome of `bureau.workflows.update`: a status, or the new hash. */
export function isResult(
  value: unknown,
): value is { readonly status: string; readonly currentHash?: string; readonly id?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof Reflect.get(value, 'status') === 'string' ||
      typeof Reflect.get(value, 'hash') === 'string')
  );
}

/** Whether `value` is the proposal that opened the page. */
export function isProposalResult(value: unknown): value is ProposalResult {
  return (
    isRecord(value) &&
    value['status'] === 'ok' &&
    typeof value['id'] === 'string' &&
    typeof value['baseHash'] === 'string' &&
    typeof value['proposedText'] === 'string'
  );
}

/** A value as the comparison shows it: words for absence, text as it is, anything else as indented JSON. */
export function valueText(value: unknown): string {
  if (value === undefined) return 'Not present';
  if (value === null) return 'None';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Whether two values are the same JSON. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The definition in a workflow's canonical text, or `undefined` when the text is not one. */
export function definitionFromCanonicalText(value: string): Definition | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed['trigger']) || !Array.isArray(parsed['steps'])) {
      return undefined;
    }
    if (!parsed['steps'].every(isRecord)) return undefined;
    const { name: _name, ...definition } = parsed;
    return definition as Definition;
  } catch {
    return undefined;
  }
}

function rowOf(label: string, oldValue: unknown, newValue: unknown): RevisionRow {
  const state: RowState = sameValue(oldValue, newValue)
    ? 'unchanged'
    : oldValue === undefined || oldValue === null
      ? 'added'
      : newValue === undefined || newValue === null
        ? 'removed'
        : 'changed';
  return {
    label,
    state,
    marker: `${state.at(0)?.toUpperCase() ?? ''}${state.slice(1)}`,
    current: valueText(oldValue),
    proposed: valueText(newValue),
  };
}

/** The rows that compare `current` with `proposed`: each named field, the trigger, then each step. */
export function revisionRows(current: Definition, proposed: Definition): RevisionRow[] {
  const rows: RevisionRow[] = [];
  for (const key of [
    'title',
    'description',
    'agent',
    'paused',
    'inputSchema',
    'outputSchema',
  ] as const) {
    rows.push(rowOf(key, current[key] ?? null, proposed[key] ?? null));
  }
  rows.push(rowOf('Trigger', current.trigger, proposed.trigger));
  const length = Math.max(current.steps.length, proposed.steps.length);
  for (let index = 0; index < length; index += 1) {
    rows.push(
      rowOf(
        `Step ${String(index + 1)}`,
        current.steps[index] ?? null,
        proposed.steps[index] ?? null,
      ),
    );
  }
  return rows;
}

/** How many of `rows` differ. */
export function changedCount(rows: readonly RevisionRow[]): number {
  return rows.filter((row) => row.state !== 'unchanged').length;
}

/** What the status line says for `state`; `message` replaces the words the state would have. */
export function statusText(
  state: RevisionState,
  changeCount: number,
  message: string | undefined,
): string {
  if (message !== undefined) return message;
  switch (state) {
    case 'loading':
      return 'Loading the current workflow definition…';
    case 'no-changes':
      return 'No changes in this proposal.';
    case 'applying':
      return 'Applying the approved revision…';
    case 'applied':
      return 'Applied. The workflow now matches the proposed definition.';
    case 'conflict':
      return 'The file changed since the proposal. Check the current definition before retrying.';
    case 'denied':
      return 'You do not have access to apply this revision. No changes were made.';
    case 'offline':
      return 'Could not confirm the update. Check the current definition before retrying.';
    case 'unknown':
      return 'The update returned an unknown result. Check the current definition before retrying.';
    case 'retryable':
      return 'The base hash is current. Retry Apply when ready.';
    case 'changed':
      return `Review ${String(changeCount)} visible change${changeCount === 1 ? '' : 's'} before applying.`;
  }
}

/** The Cinder callout variant that carries `state`'s status line. */
export function statusVariant(
  state: RevisionState,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'applied':
      return 'success';
    case 'conflict':
    case 'denied':
      return 'danger';
    case 'offline':
    case 'unknown':
      return 'warning';
    case 'changed':
    case 'retryable':
      return 'info';
    default:
      return 'neutral';
  }
}

/** The label of the Apply button in `state`. */
export function applyLabel(state: RevisionState): string {
  switch (state) {
    case 'applying':
      return 'Applying…';
    case 'applied':
      return 'Applied';
    case 'retryable':
      return 'Retry Apply';
    default:
      return 'Apply';
  }
}

/** Whether Apply can be pressed in `state`. */
export function canApply(state: RevisionState): boolean {
  return state === 'changed' || state === 'retryable';
}

/** Whether the page offers to check the current hash in `state`, and whether the check is disabled. */
export function checkHashOffer(state: RevisionState): { offered: boolean; disabled: boolean } {
  return {
    offered: state === 'offline' || state === 'unknown' || state === 'retryable',
    disabled: state === 'retryable',
  };
}
