/**
 * The input and output schemas of a workflow file (COR-1812): a JSON Schema (draft 2020-12) the
 * file declares for what an instance starts with and what it finishes with.
 *
 * ## What `inputSchema` describes
 *
 * The input is the value that started the instance, not the trigger object the engine records it
 * under. A manual start (`bureau.workflows.start`) supplies `input`; a signal trigger supplies the
 * signal's `payload`; a schedule fire supplies nothing, which is `null`. A raw start through the
 * engine (`weft.workflows.start`) supplies whatever it was given, taken as the input as it is. A
 * schedule-triggered workflow whose `inputSchema` does not accept `null` therefore fails every fire
 * with `input-invalid`.
 *
 * ## Where it is enforced
 *
 * The three starts Bureau makes check the input before the engine is asked to start, so a start
 * that fails creates no run: {@link WorkflowInputInvalidError}. The interpreter checks it again as
 * the instance begins, which is what catches a schedule fire (Weft makes it, not Bureau) and a raw
 * engine start: that instance exists and fails with `input-invalid`. The output is checked when
 * the last step is done, and an instance whose result breaks the schema fails with
 * `output-invalid`. Both codes begin the failed run's `error` text, which
 * {@link finishReasonOf} reads back.
 *
 * Schemas are held to the limits of a human-input answer schema (`checkHumanInputSchema`): a JSON
 * object, at most 32 KiB, nested at most 8 levels, with no `$id`, `pattern`, or `patternProperties`.
 *
 * @module workflow-schema
 */

import { checkHumanInputSchema, HumanInputSchemaError } from '@lostgradient/operative';
import type { DocumentSchemaChecker, WorkflowDocumentIssue } from '@lostgradient/weft';

import { validateAgainstSchema } from './review-answer';

/** The two schemas a workflow file may declare, by the key each has in the file. */
export type WorkflowSchemaKey = 'inputSchema' | 'outputSchema';

/** Why a run failed because of its schemas: the code its failed run's `error` text begins with. */
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

/**
 * The value an `inputSchema` describes, taken from the trigger an instance was started with. See
 * the module comment for what each start supplies.
 */
export function workflowInputOf(trigger: unknown): unknown {
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    return trigger ?? null;
  }
  const record = trigger as Readonly<Record<string, unknown>>;
  switch (record['kind']) {
    case 'manual':
      return record['input'] ?? null;
    case 'signal':
      return record['payload'] ?? null;
    case 'schedule':
      return null;
    default:
      return trigger;
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
 * Why a failed run failed, when it failed on a schema: `input-invalid` or `output-invalid`, read
 * from the start of the run's `error` text. `null` for any other error, or none.
 */
export function finishReasonOf(error: string | undefined): WorkflowFinishReason | null {
  if (error === undefined) return null;
  if (error.startsWith('input-invalid: ')) return 'input-invalid';
  if (error.startsWith('output-invalid: ')) return 'output-invalid';
  return null;
}
