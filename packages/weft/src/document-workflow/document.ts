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

import { compareCodepoint } from '../core/compare-codepoint.ts';
import { isJSONValue, type JSONValue } from '../core/json.ts';
import { parseDuration } from '../core/scheduler.ts';
import { validateWorkflowOrActivityName } from '../core/types/name-grammar.ts';
import { sha256Hex } from '../worker/manifest/content-digest.ts';

/**
 * The argument every document activity handler receives: the step's static
 * `input`, the `trigger` that started the instance, and `previous`, the prior
 * step's result. `previous` is the prior activity's output, the signal payload
 * after an `await-signal` step, `null` after a `sleep` step, and `null` for the
 * first step.
 */
export type DocumentActivityArgument = Readonly<{
  input: JSONValue;
  trigger: unknown;
  previous: unknown;
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

/** What a host registers so documents can name its activities and trigger kinds. */
export interface DocumentWorkflowHost {
  /** Activity handlers keyed by the name a document's `activity` step uses. */
  readonly activities: Readonly<Record<string, DocumentActivityHandler>>;
  /** Trigger validators keyed by the `kind` a document's `trigger` uses. */
  readonly triggerKinds: Readonly<Record<string, DocumentTriggerValidator>>;
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
}

const jsonValueSchema = z.custom<JSONValue>(isJSONValue, 'must be a JSON value');

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

function hostIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  const issues: WorkflowDocumentIssue[] = [];
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
    if (step.kind === 'activity' && !Object.hasOwn(host.activities, step.handler)) {
      issues.push({
        path: `steps[${String(index)}].handler`,
        message: `activity handler "${step.handler}" is not registered`,
      });
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

function canonicalJson(value: JSONValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, JSONValue | undefined>;
  const members: string[] = [];
  for (const key of Object.keys(record).toSorted(compareCodepoint)) {
    const member = record[key];
    if (member !== undefined) members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${members.join(',')}}`;
}

/**
 * The canonical JSON of a document: object keys sorted by code point at every
 * depth, array order preserved, and no whitespace between tokens. Equal content
 * always serializes to the same text.
 */
export function canonicalWorkflowDocumentJson(document: WorkflowDocument): string {
  return canonicalJson(document as unknown as JSONValue);
}

/**
 * A document's version: `sha256:` followed by the hex SHA-256 of its
 * {@link canonicalWorkflowDocumentJson}. It is carried as the registered
 * workflow's `workflowVersion`, so identical content always has the same
 * version and any change to a step has a different one.
 */
export function workflowDocumentVersion(document: WorkflowDocument): Promise<string> {
  return sha256Hex(canonicalWorkflowDocumentJson(document));
}
