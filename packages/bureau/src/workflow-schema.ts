/**
 * The input and output schemas of a workflow file (COR-1812): a JSON Schema (draft 2020-12) the
 * file declares for what an instance starts with and what it finishes with.
 *
 * ## What `inputSchema` describes
 *
 * The input is the value that started the instance, not the trigger object the engine records it
 * under. A manual start (`bureau.workflows.start`) supplies `input`; a signal trigger supplies the
 * signal's `payload`; a contributed trigger kind (`plugin:name`, COR-1874) supplies the `payload`
 * its `fire` was given; a schedule fire supplies nothing, which is `null`. A raw start through the
 * engine (`weft.workflows.start`) supplies whatever it was given, taken as the input as it is. A
 * schedule-triggered workflow whose `inputSchema` does not accept `null` would therefore fail every
 * fire with `input-invalid`, so `parseWorkflowFile` refuses such a file when it is written.
 *
 * ## Where it is enforced
 *
 * The three starts Bureau makes check the input before the engine is asked to start, so a start
 * that fails creates no run: {@link WorkflowInputInvalidError}. The interpreter checks it again as
 * the instance begins, which is what catches a schedule fire (Weft makes it, not Bureau) and a raw
 * engine start: that instance exists and fails with `input-invalid`. The output is checked when
 * the last step is done, and an instance whose result breaks the schema fails with
 * `output-invalid`. Both codes begin the failed run's `error` text, but {@link finishReasonOf} reads
 * the reason from the class of the error the check threw, not from that text.
 *
 * Schemas are held to the limits of a human-input answer schema (`checkHumanInputSchema`): a JSON
 * object, at most 32 KiB, nested at most 8 levels, with no `$id`, `pattern`, or `patternProperties`.
 *
 * @module workflow-schema
 */

import { checkHumanInputSchema, HumanInputSchemaError } from '@lostgradient/operative';
import {
  type DocumentSchemaChecker,
  type WorkflowDocumentIssue,
  WorkflowDocumentSchemaError,
} from '@lostgradient/weft';

import { isNamespacedIdentifier } from './namespaced-identifier';
import { validateAgainstSchema } from './review-answer';

/** The two schemas a workflow file may declare, by the key each has in the file. */
export type WorkflowSchemaKey = 'inputSchema' | 'outputSchema';

/** Why a run failed because of its schemas: the code of the error the schema check threw. */
export type WorkflowFinishReason = 'input-invalid' | 'output-invalid';

/** One way a value breaks a workflow's schema: where in the value, and what is wrong. */
export interface WorkflowSchemaIssue {
  /** The location inside the value, as property names and array indexes; `[]` is the value itself. */
  readonly path: ReadonlyArray<string | number>;
  /** What is wrong, in a sentence a person or an agent can act on. */
  readonly message: string;
}

/** A start whose input does not satisfy the workflow's `inputSchema`. No instance was created. */
export class WorkflowInputInvalidError extends Error {
  /** Always `input-invalid`. */
  readonly code = 'input-invalid';
  /** The workflow that refused the input. */
  readonly workflow: string;
  /** Every way the input failed the schema. */
  readonly issues: readonly WorkflowSchemaIssue[];

  constructor(workflow: string, issues: readonly WorkflowSchemaIssue[]) {
    super(
      `The input does not satisfy the input schema of workflow "${workflow}": ${issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'WorkflowInputInvalidError';
    this.workflow = workflow;
    this.issues = issues;
  }
}

/** Dotted text for a path, as a file issue spells it. */
function dotted(path: ReadonlyArray<string | number>): string {
  return path.join('.');
}

/**
 * The issues with a schema a file declared: none when it is acceptable. `key` names the file's
 * field, and an issue's `path` begins with it (`inputSchema.properties`).
 */
export function workflowSchemaIssues(
  key: WorkflowSchemaKey,
  schema: unknown,
): WorkflowDocumentIssue[] {
  try {
    checkHumanInputSchema(key, schema);
    return [];
  } catch (error) {
    if (!(error instanceof HumanInputSchemaError)) throw error;
    return error.issues.map((issue) => ({
      path: issue.path.length === 0 ? key : `${key}.${dotted(issue.path)}`,
      message: issue.message,
    }));
  }
}

/** Whether `record` has no key outside `allowed`, so a raw input that merely shares a `kind` is not taken for an envelope. */
function onlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/**
 * The value an `inputSchema` describes, taken from the trigger an instance was started with. See
 * the module comment for what each start supplies.
 *
 * Only the exact envelopes Bureau and Weft write are unwrapped: `{ kind: 'manual', input, origin }`,
 * `{ kind: 'signal', name, payload }`, `{ kind: 'schedule', scheduleId }`, and a contributed
 * trigger kind's `{ kind: 'plugin:name', payload }`, each with its required fields and no others. A raw start whose input merely has a `kind` of `manual`, `signal`
 * or `schedule` (`{ kind: 'manual', city: 'Oslo' }`) is its own input. A raw input that spells out
 * a whole envelope is indistinguishable from one, which is why the trigger is the one place the
 * envelope's shape is decided.
 */
export function workflowInputOf(trigger: unknown): unknown {
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    return trigger ?? null;
  }
  const record = trigger as Readonly<Record<string, unknown>>;
  const isObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  switch (record['kind']) {
    case 'manual':
      return isObject(record['origin']) && onlyKeys(record, ['kind', 'input', 'origin'])
        ? (record['input'] ?? null)
        : trigger;
    case 'signal':
      return typeof record['name'] === 'string' && onlyKeys(record, ['kind', 'name', 'payload'])
        ? (record['payload'] ?? null)
        : trigger;
    case 'schedule':
      return typeof record['scheduleId'] === 'string' &&
        onlyKeys(record, ['kind', 'scheduleId', 'fireId'])
        ? null
        : trigger;
    default:
      return typeof record['kind'] === 'string' &&
        isNamespacedIdentifier(record['kind']) &&
        onlyKeys(record, ['kind', 'payload'])
        ? (record['payload'] ?? null)
        : trigger;
  }
}

function issueOf(issue: {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}): WorkflowSchemaIssue {
  return { path: issue.path, message: issue.message };
}

/** Every way `input` (the value that starts a workflow, see {@link workflowInputOf}) breaks `schema`. */
export function inputSchemaIssues(
  schema: Readonly<Record<string, unknown>>,
  input: unknown,
): readonly WorkflowSchemaIssue[] {
  return validateAgainstSchema(schema, input, 'The input').map(issueOf);
}

/**
 * The schema checker the workflow host gives Weft's interpreter. At the `'input'` point it is given
 * the trigger the instance started with and reads the input from it; at `'output'` it is given the
 * result. Its issues are located by dotted path, as a document's are.
 */
export const checkWorkflowSchema: DocumentSchemaChecker = (point, schema, value) => {
  const issues =
    point === 'input'
      ? validateAgainstSchema(schema, workflowInputOf(value), 'The input')
      : validateAgainstSchema(schema, value, 'The output');
  return issues.map((issue) => ({ path: dotted(issue.path), message: issue.message }));
};

/**
 * The class name Weft gives the error it throws when a value breaks a schema. A failed run keeps no
 * error object, only its message and the stack the error carried, and that stack opens with the
 * error's class name (COR-1927).
 */
const SCHEMA_ERROR_NAME = new WorkflowDocumentSchemaError('input-invalid', []).name;

/**
 * Why a failed run failed, when it failed on a schema: `input-invalid` or `output-invalid`. `stack`
 * is the `errorStack` the run kept.
 *
 * It is read from the class and code of the error the schema check threw, which the run's stored
 * `errorStack` opens with (`WorkflowDocumentSchemaError: input-invalid: …`), and never from the
 * message alone: a message is whatever any activity, a contributed one included, chose to throw, so
 * `new Error('input-invalid: …')` is not a schema failure. A run that kept no stack, or failed for
 * any other reason, has `null`. (The durable fix is for Weft to keep the thrown error's class on the
 * run's state, which would make the stack unnecessary.)
 */
export function finishReasonOf(stack: string | undefined): WorkflowFinishReason | null {
  if (stack === undefined) return null;
  for (const reason of ['input-invalid', 'output-invalid'] as const) {
    if (stack.startsWith(`${SCHEMA_ERROR_NAME}: ${reason}: `)) return reason;
  }
  return null;
}
