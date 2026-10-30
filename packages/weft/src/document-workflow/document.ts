/**
 * The declarative workflow document: an agent-authored JSON description of a
 * workflow as a trigger plus an ordered list of steps. Weft validates it,
 * derives its version from its canonical JSON, and (see `register.ts`) runs
 * it through one interpreter. Weft persists no documents and attaches no
 * owner to one: the host supplies the content and keeps whatever record of
 * authorship it needs.
 *
 * @module document-workflow/document
 */

import { z } from 'zod';

import { isJSONValue, type JSONValue } from '../core/json.ts';
import { parseDuration } from '../core/scheduler.ts';
import { validateWorkflowOrActivityName } from '../core/types/name-grammar.ts';
import { canonicalJsonStringify } from '../worker/manifest/canonical-json.ts';
import { sha256Hex } from '../worker/manifest/content-digest.ts';

/**
 * The argument every document activity handler receives: the step's static
 * `input`, the `trigger` that started the instance, and `previous`, the prior
 * step's result. `previous` is the prior activity's output, the signal payload
 * after an `await-signal` step, `null` after a `sleep` step, and `null` for the
 * first step.
 *
 * `workflowId` and `step` identify the step being run: the instance's workflow
 * id, and the zero-based index of the step among all of the document's steps
 * (sleeps and signal waits count). The pair is the same every time that step
 * runs, including when a restart re-executes an activity that was in flight, so
 * a handler with an external effect can derive a deterministic key from it and
 * recognise its own earlier attempt instead of repeating the effect.
 */
export type DocumentActivityArgument = Readonly<{
  input: JSONValue;
  trigger: unknown;
  previous: unknown;
  workflowId: string;
  step: number;
}>;

/**
 * A host-registered activity handler a document names by key. A thrown error
 * fails the instance with that error; documents carry no per-step retry.
 */
export type DocumentActivityHandler = (argument: DocumentActivityArgument) => unknown;

/**
 * Validates one document's `trigger` object for its kind. Return `undefined`
 * when the trigger is acceptable, or a message explaining why it is not. Weft
 * never interprets a trigger beyond its `kind`: what a trigger means belongs
 * to the host.
 */
export type DocumentTriggerValidator = (
  trigger: Readonly<Record<string, JSONValue>>,
) => string | undefined;

/** Where in a run a schema is checked: the instance's start input, or the value it finishes with. */
export type DocumentSchemaPoint = 'input' | 'output';

/**
 * Checks `value` against a document's `inputSchema` or `outputSchema` and returns every way it
 * fails, or `[]` when it satisfies the schema. At the `'input'` point `value` is the instance's
 * start input, the trigger the engine started it with, and the host decides which part of it the
 * schema describes. At the `'output'` point `value` is the result of the document's last step.
 * Weft never reads a schema itself: what a schema means and which rules it is held to belong to
 * the host.
 */
export type DocumentSchemaChecker = (
  point: DocumentSchemaPoint,
  schema: Readonly<Record<string, JSONValue>>,
  value: unknown,
) => readonly WorkflowDocumentIssue[];

/** What a host registers so documents can name its activities and trigger kinds. */
export interface DocumentWorkflowHost {
  /** Activity handlers keyed by the name a document's `activity` step uses. */
  readonly activities: Readonly<Record<string, DocumentActivityHandler>>;
  /** Trigger validators keyed by the `kind` a document's `trigger` uses. */
  readonly triggerKinds: Readonly<Record<string, DocumentTriggerValidator>>;
  /**
   * Checks a value against a document's `inputSchema` or `outputSchema`. A document that declares
   * either needs a host that has this, and is refused by {@link validateWorkflowDocument}
   * otherwise, because a schema nothing checks would promise a guarantee nobody keeps.
   */
  readonly checkSchema?: DocumentSchemaChecker | undefined;
}

/** One step of a {@link WorkflowDocument}. */
export type WorkflowDocumentStep =
  | Readonly<{ kind: 'activity'; handler: string; input?: JSONValue }>
  | Readonly<{ kind: 'sleep'; duration: string | number }>
  | Readonly<{ kind: 'await-signal'; signal: string }>;

/** A declarative workflow: a name, an opaque trigger, and ordered steps. */
export interface WorkflowDocument {
  /** Becomes the workflow type name; must satisfy the wire-safe name grammar. */
  readonly name: string;
  /** Host-defined trigger. Only `kind` is read, to pick the host's validator. */
  readonly trigger: Readonly<{ kind: string } & Record<string, JSONValue>>;
  /** Run in order; at least one. */
  readonly steps: readonly WorkflowDocumentStep[];
  /**
   * A JSON Schema describing the input an instance starts with, checked by the host's
   * {@link DocumentWorkflowHost.checkSchema} when the instance begins. Optional: a document
   * without it is the document it always was, with the version it always had.
   */
  readonly inputSchema?: Readonly<Record<string, JSONValue>>;
  /**
   * A JSON Schema describing the value the instance finishes with, checked by the host's
   * {@link DocumentWorkflowHost.checkSchema} when the last step is done. An instance whose result
   * does not satisfy it fails with {@link WorkflowDocumentSchemaError}. Optional like
   * `inputSchema`.
   */
  readonly outputSchema?: Readonly<Record<string, JSONValue>>;
}

const jsonValueSchema = z.custom<JSONValue>(isJSONValue, 'must be a JSON value');

const jsonObjectSchema = z.custom<Record<string, JSONValue>>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && isJSONValue(value),
  'must be a JSON object',
);

const nameSchema = z.string().superRefine((name, context) => {
  try {
    validateWorkflowOrActivityName(name, 'workflow');
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const durationSchema = z.union([z.string(), z.number()]).superRefine((duration, context) => {
  try {
    parseDuration(duration);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'must be a finite, non-negative number of milliseconds or a duration string',
    });
  }
});

const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('activity'),
    handler: z.string().min(1),
    input: jsonValueSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('sleep'), duration: durationSchema }),
  z.strictObject({ kind: z.literal('await-signal'), signal: z.string().min(1) }),
]);

/**
 * Structural schema for a {@link WorkflowDocument}. It does not know the
 * host's registered handlers and trigger kinds: {@link validateWorkflowDocument}
 * checks those as well.
 */
export const workflowDocumentSchema = z.strictObject({
  name: nameSchema,
  trigger: z.looseObject({ kind: z.string().min(1) }).superRefine((trigger, context) => {
    if (!isJSONValue(trigger)) {
      context.addIssue({ code: 'custom', message: 'must contain only JSON values' });
    }
  }),
  steps: z.array(stepSchema).min(1),
  inputSchema: jsonObjectSchema.optional(),
  outputSchema: jsonObjectSchema.optional(),
});

/** One reason a document was rejected, located by a path such as `steps[2].handler`. */
export type WorkflowDocumentIssue = Readonly<{ path: string; message: string }>;

/** Thrown by {@link validateWorkflowDocument} with every reason the document was rejected. */
export class WorkflowDocumentValidationError extends Error {
  readonly issues: readonly WorkflowDocumentIssue[];

  constructor(issues: readonly WorkflowDocumentIssue[]) {
    const summary = issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join('; ');
    super(`Invalid workflow document: ${summary}`);
    this.name = 'WorkflowDocumentValidationError';
    this.issues = issues;
  }
}

/**
 * A run ended because its input or output did not satisfy the document's schema. The message
 * begins with `code`, then `: `, then each issue as `path: message` joined by `; `, so a host that
 * reads only a failed run's `error` text can tell the two apart.
 */
export class WorkflowDocumentSchemaError extends Error {
  /** Which schema the value broke. */
  readonly code: 'input-invalid' | 'output-invalid';
  /** Every way the value failed the schema. */
  readonly issues: readonly WorkflowDocumentIssue[];

  constructor(code: 'input-invalid' | 'output-invalid', issues: readonly WorkflowDocumentIssue[]) {
    const summary = issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join('; ');
    super(`${code}: ${summary}`);
    this.name = 'WorkflowDocumentSchemaError';
    this.code = code;
    this.issues = issues;
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted;
}

/** Why `name` cannot be an activity name, or `undefined` when it can. */
function activityNameIssue(name: string): string | undefined {
  try {
    validateWorkflowOrActivityName(name, 'activity');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A document that declares a schema needs a host that checks it. */
function schemaHostIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  if (host.checkSchema !== undefined) return [];
  return (['inputSchema', 'outputSchema'] as const)
    .filter((key) => document[key] !== undefined)
    .map((key) => ({
      path: key,
      message: `this host does not check schemas, so a document cannot declare "${key}"`,
    }));
}

function hostIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  const issues: WorkflowDocumentIssue[] = schemaHostIssues(document, host);
  const validator = Object.hasOwn(host.triggerKinds, document.trigger.kind)
    ? host.triggerKinds[document.trigger.kind]
    : undefined;
  if (validator === undefined) {
    issues.push({
      path: 'trigger.kind',
      message: `trigger kind "${document.trigger.kind}" is not registered`,
    });
  } else {
    const reason = validator(document.trigger);
    if (reason !== undefined) issues.push({ path: 'trigger', message: reason });
  }
  for (const [index, step] of document.steps.entries()) {
    if (step.kind !== 'activity') continue;
    const path = `steps[${String(index)}].handler`;
    const nameIssue = activityNameIssue(step.handler);
    if (nameIssue !== undefined) {
      issues.push({ path, message: nameIssue });
    } else if (!Object.hasOwn(host.activities, step.handler)) {
      issues.push({ path, message: `activity handler "${step.handler}" is not registered` });
    }
  }
  return issues;
}

/**
 * Validate `input` as a {@link WorkflowDocument} against what `host` has
 * registered, and return a detached copy. Call it when a document is written:
 * a document naming an unregistered activity handler or trigger kind throws a
 * {@link WorkflowDocumentValidationError} listing every problem found.
 */
export function validateWorkflowDocument(
  input: unknown,
  host: DocumentWorkflowHost,
): WorkflowDocument {
  const parsed = workflowDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowDocumentValidationError(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  const document = structuredClone(parsed.data) as WorkflowDocument;
  const issues = hostIssues(document, host);
  if (issues.length > 0) throw new WorkflowDocumentValidationError(issues);
  return document;
}

/**
 * The canonical JSON of a document: object keys sorted by UTF-16 code unit
 * (JavaScript's default string order, which is what RFC 8785 specifies) at every
 * depth, array order preserved, and no whitespace between tokens. Equal content
 * always serializes to the same text. Strings are written as they are, with no
 * Unicode normalization.
 */
export function canonicalWorkflowDocumentJson(document: WorkflowDocument): string {
  return canonicalJsonStringify(document);
}

/**
 * A document's version: `sha256:` followed by the hex SHA-256 of its
 * {@link canonicalWorkflowDocumentJson}. It is carried as the registered
 * workflow's `workflowVersion`, so identical content always has the same
 * version and any change to a step has a different one.
 *
 * The version is a content identity, not a meaning identity. An absent `input`
 * and `input: null`, or the durations `'1m'` and `60000`, mean the same to the
 * interpreter but are different content, so they have different versions.
 *
 * Invariant for every future change to the schema: the hash covers exactly the
 * value the author wrote. The parser must never add a default, rename a key, or
 * otherwise produce a value the author did not write, because that would move
 * the version of every existing document. A field added later is `.optional()`,
 * and its absence means the current shape. `src/document-workflow/document.test.ts`
 * pins the version of a fixed document to catch any drift.
 */
export function workflowDocumentVersion(document: WorkflowDocument): Promise<string> {
  return sha256Hex(canonicalWorkflowDocumentJson(document));
}
