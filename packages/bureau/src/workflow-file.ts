/**
 * The workflow file format (COR-1527): one agent-authored workflow as a JSON file in a directory
 * the host names. A file is COR-1525's workflow document plus Bureau's own fields, and nothing else:
 *
 * ```json
 * {
 *   "name": "nightly-digest",
 *   "title": "Nightly digest",
 *   "description": "Summarizes the night's activity for the team.",
 *   "agent": "writer",
 *   "paused": false,
 *   "trigger": {
 *     "kind": "schedule",
 *     "name": "Morning digest",
 *     "spec": "0 6 * * *",
 *     "timezone": "America/Chicago",
 *     "overlap": "skip",
 *     "catchUp": false
 *   },
 *   "inputSchema": { "type": "null" },
 *   "outputSchema": { "type": "string" },
 *   "steps": [
 *     { "title": "Write the digest", "kind": "activity", "handler": "agent",
 *       "input": { "agent": "writer", "message": "..." } },
 *     { "title": "Wait for a person", "kind": "await-signal", "signal": "digest-approved",
 *       "review": true }
 *   ]
 * }
 * ```
 *
 * ## The extended format (COR-2009)
 *
 * The builder and the file agree on these keys, all optional, and Bureau strips every one of them
 * before it hands the document to Weft, so none is part of a revision's Weft `workflowVersion`:
 *
 * - `title` on the workflow: the name a person reads, shown as the heading with the identifier
 *   beside it. With none, the identifier is the heading.
 * - `title` on any step: the step's name. Renaming a step is never a breaking change.
 * - `review: true` on an `await-signal` step: a person decides it, so the waiting instance shows in
 *   Reviews ("Wait for a person"). Without it the step waits for an outside signal and does not.
 * - `timezone` (an IANA zone, cron schedules only) and `catchUp` (a boolean; `false`, the default,
 *   skips the runs missed while the host was off) on a `schedule` trigger. They configure the
 *   schedule the file owns, as Weft's `timeZone` and `backfill`.
 * - `name` on a `schedule` trigger: the schedule's display name, such as "Release notes digest",
 *   which the schedule carries as its Weft `description`. With none, the schedule is described as
 *   `Workflow <identifier>`.
 * - `input` on a `schedule` trigger: the fixed value every fire starts its instance with, judged
 *   against `inputSchema` when the file is written. With none, a fire starts with `null`.
 *
 * The trigger kind `manual` (`{ "kind": "manual" }`) is the one extension Weft does see: a
 * workflow that only starts when someone starts it.
 *
 * `inputSchema` and `outputSchema` are optional JSON Schemas for what an instance starts with and
 * finishes with (see `workflow-schema.ts`). Unlike the three fields above they stay in the
 * document Weft is handed, so they are part of a revision: a file that declares none keeps the
 * version it always had, and one that declares either has a different version.
 *
 * The filename without `.json` is the workflow's identifier and the document's `name` must equal
 * it. `description` says in a sentence what the workflow is for (optional), `agent` records which
 * agent wrote the file (it is not checked against the agent catalog) and `paused` stops the
 * workflow starting anything new; Bureau strips all three before it hands the document to Weft, so
 * none is part of a revision, and neither is any key of the extended format above. This module is
 * the pure half: parsing, validating, serializing, hashing. It touches no file and no engine.
 *
 * @module workflow-file
 */

import { createHash } from 'node:crypto';

import {
  canonicalWorkflowDocumentJson,
  type DocumentWorkflowHost,
  workflowDocumentSchema,
  WorkflowDocumentValidationError,
  type WorkflowDocument,
  type WorkflowDocumentIssue,
} from '@lostgradient/weft';

import { AGENT_IDENTIFIER_PATTERN } from './agent-file';
import { NAMESPACED_IDENTIFIER_SOURCE, weftNameOf } from './namespaced-identifier';
import { toScheduleSpec } from './schedule-spec';
import { toWeftDocument, validateBureauWorkflowDocument } from './workflow-document-handlers';
import { inputSchemaIssues, workflowSchemaIssues } from './workflow-schema';

/**
 * What an owner's workflow file stem must look like: a letter first, and it doubles as a path
 * segment. No colon, so an owner file cannot claim a plugin's namespace (COR-1871).
 */
export const WORKFLOW_FILE_STEM_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * What a workflow's identifier must look like: an owner's bare stem, or the `plugin:name` a plugin
 * contributes. Percent-encode it where it becomes a URL path segment.
 */
export const WORKFLOW_IDENTIFIER_PATTERN = new RegExp(
  `^(?:${WORKFLOW_FILE_STEM_PATTERN.source.slice(1, -1)}|${NAMESPACED_IDENTIFIER_SOURCE})$`,
);

/** The longest identifier, so the ids Bureau derives from it stay inside Weft's 128 characters. */
export const WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH = 64;

/** The extension a workflow file carries. Matched exactly: `x.JSON` is another kind of file. */
export const WORKFLOW_FILE_EXTENSION = '.json';

/** The largest workflow file Bureau reads, in bytes. A larger one is `invalid`. */
export const WORKFLOW_FILE_SIZE_LIMIT = 256 * 1024;

/**
 * The keys each trigger kind takes, besides `kind`. Weft's document schema leaves a trigger open,
 * so the keys are Bureau's to know: the host's validators refuse any other, and
 * {@link documentHasUnrecognizedTriggerKeys} reads the same table to tell a key this Bureau does
 * not know from another fault (COR-1927).
 */
export const TRIGGER_KEYS: Readonly<Record<string, readonly string[]>> = {
  schedule: ['spec', 'overlap', 'timezone', 'catchUp', 'name', 'input'],
  signal: ['name'],
  manual: [],
};

/** The keys of a `schedule` trigger that configure its schedule and that Bureau strips before Weft. */
export const SCHEDULE_TRIGGER_EXTENSION_KEYS = ['timezone', 'catchUp', 'name', 'input'] as const;

/** The keys of a step that are Bureau's alone and that Bureau strips before Weft (COR-2009). */
export const STEP_EXTENSION_KEYS = ['title', 'review'] as const;

/** The longest workflow or step `title`, in characters: a name for a heading, not a sentence. */
export const WORKFLOW_TITLE_MAXIMUM_LENGTH = 120;

/** Whether `value` is a usable `title`: a non-blank string of at most the limit. */
function isTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= WORKFLOW_TITLE_MAXIMUM_LENGTH
  );
}

const TITLE_MESSAGE = `must be a non-empty string of at most ${String(WORKFLOW_TITLE_MAXIMUM_LENGTH)} characters`;

/** Whether `timeZone` is an IANA time zone the runtime knows, such as `America/Chicago` or `UTC`. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    // Throws a `RangeError` for a zone the runtime does not know.
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/**
 * Why the `timezone`, `catchUp`, or `name` of a `schedule` trigger is wrong, or `undefined` when
 * each is absent or right. `timezone` names an IANA zone and needs a cron `spec`, because an
 * interval counts elapsed time and Weft refuses a zone for one; `catchUp` is `true` or `false`;
 * `name` is a non-blank string of at most {@link WORKFLOW_TITLE_MAXIMUM_LENGTH} characters. Any
 * JSON value is an `input`; whether the file's `inputSchema` accepts it is judged with the
 * document.
 */
export function scheduleTriggerExtensionIssue(
  trigger: Readonly<Record<string, unknown>>,
): string | undefined {
  const timeZone = trigger['timezone'];
  if (timeZone !== undefined) {
    if (typeof timeZone !== 'string' || !isKnownTimeZone(timeZone)) {
      return '"timezone" must be an IANA time zone, such as "America/Chicago" or "UTC"';
    }
    const spec = trigger['spec'];
    if (typeof spec === 'string' && 'every' in toScheduleSpec(spec)) {
      return '"timezone" applies only to a cron "spec": an interval such as "1h" counts elapsed time';
    }
  }
  const catchUp = trigger['catchUp'];
  if (catchUp !== undefined && typeof catchUp !== 'boolean') {
    return '"catchUp" must be true or false';
  }
  if (Object.hasOwn(trigger, 'name') && !isTitle(trigger['name'])) {
    return `"name" ${TITLE_MESSAGE}`;
  }
  return undefined;
}

/**
 * Whether `trigger` is of a kind this Bureau knows and carries a key that kind does not take: what
 * a newer Bureau writes when a trigger grows an option. A kind this Bureau does not know is not
 * judged here.
 */
export function triggerHasUnrecognizedKeys(trigger: unknown): boolean {
  if (!isPlainObject(trigger)) return false;
  const kind = trigger['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(TRIGGER_KEYS, kind)) return false;
  const known = TRIGGER_KEYS[kind] ?? [];
  return Object.keys(trigger).some((key) => key !== 'kind' && !known.includes(key));
}

/** The handler name of the activity every agent step names. */
export const AGENT_STEP_HANDLER = 'agent';

/** Why a file cannot be used as a workflow. Carried on the listing, and on a refused write. */
export type WorkflowFileProblemCode =
  | 'invalid-identifier'
  | 'invalid-json'
  | 'invalid-document'
  | 'shadows-code-workflow'
  | 'file-too-large'
  | 'not-utf8'
  | 'unreadable';

/** One schema failure: where it is and what is wrong. */
export type WorkflowFileIssue = WorkflowDocumentIssue;

/** A file that cannot be used, as plain data a listing can carry. */
export interface WorkflowFileProblem {
  readonly code: WorkflowFileProblemCode;
  readonly message: string;
  /** Every failure found, for `invalid-document`. */
  readonly issues?: readonly WorkflowFileIssue[];
  /**
   * Present, and `true`, when the document holds a key this host does not know (COR-1927): the
   * mark of a file written by a newer Bureau, which this one cannot read but must not treat as
   * broken. A host that cannot read a file this way leaves the file's schedule and instances alone
   * instead of cancelling them; a revision it had already registered stays registered, and may
   * keep launching from the schedule until a restart. It says nothing about other failures a file may also have.
   */
  readonly unrecognizedKeys?: true;
}

/** The longest `description`, in characters: a sentence for a list row, not a document. */
export const WORKFLOW_DESCRIPTION_MAXIMUM_LENGTH = 280;

/**
 * A file's trigger as written: `kind` and the keys of that kind, a schedule's `timezone`,
 * `catchUp`, `name`, and `input` included.
 */
export type WorkflowFileTrigger = Readonly<{ kind: string } & Record<string, unknown>>;

/** One step as written in a file, its `title` and `review` included. */
export type WorkflowFileStep = Readonly<Record<string, unknown>>;

/**
 * The file steps in the same preorder used by Weft's document revision and step identities.
 * Branch wrappers count as steps; cases are visited in canonical UTF-16 key order, followed by
 * `otherwise`, so every consumer that joins written metadata to an engine step uses one index.
 */
export function workflowFileStepsInCanonicalOrder<T extends WorkflowFileStep>(
  steps: readonly T[],
): readonly { readonly step: T; readonly index: number; readonly path: string }[] {
  const ordered: { step: T; index: number; path: string }[] = [];
  const visit = (nested: readonly T[], parentPath: string): void => {
    for (const [position, step] of nested.entries()) {
      const path = `${parentPath}[${String(position)}]`;
      ordered.push({ step, index: ordered.length, path });
      if (!isPlainObject(step)) continue;
      if (step['kind'] === 'map' && Array.isArray(step['steps'])) {
        visit(step['steps'] as T[], `${path}.steps`);
        continue;
      }
      if (step['kind'] === 'parallel' && isPlainObject(step['branches'])) {
        for (const name of Object.keys(step['branches']).toSorted()) {
          const branch = step['branches'][name];
          if (Array.isArray(branch)) visit(branch as T[], `${path}.branches.${name}`);
        }
        continue;
      }
      if (step['kind'] !== 'branch' || !isPlainObject(step['cases'])) continue;
      for (const literal of Object.keys(step['cases']).toSorted()) {
        const branch = step['cases'][literal];
        if (Array.isArray(branch)) visit(branch as T[], `${path}.cases.${literal}`);
      }
      const otherwise = step['otherwise'];
      if (Array.isArray(otherwise)) visit(otherwise as T[], `${path}.otherwise`);
    }
  };
  visit(steps, 'steps');
  return ordered;
}

/** What Bureau reads from one step beyond Weft's document (COR-2009). */
export interface WorkflowStepAnnotation {
  /** The step's `title`, or `null` when it has none. */
  readonly title: string | null;
  /** Whether the step is an `await-signal` a person decides (`review: true`), which shows in Reviews. */
  readonly review: boolean;
}

/** What a usable file holds, with Bureau's own fields split from the document. */
export interface WorkflowFileContents {
  /** The workflow's `title`, the name a person reads, or `null` when the file gives none. */
  readonly title: string | null;
  /** What the workflow is for, in a sentence, or `null` when the file gives none. */
  readonly description: string | null;
  /** The identifier of the agent that wrote the file, or `null`. */
  readonly agent: string | null;
  readonly paused: boolean;
  /** The JSON Schema the input of an instance must satisfy, or `null` when the file declares none. */
  readonly inputSchema: Readonly<Record<string, unknown>> | null;
  /** The JSON Schema the result of an instance must satisfy, or `null` when the file declares none. */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  /**
   * The trigger as written, with the `timezone`, `catchUp`, `name`, and `input` that the document's
   * trigger lacks.
   */
  readonly trigger: WorkflowFileTrigger;
  /** The steps as written, with the `title` and `review` that the document's steps lack. */
  readonly steps: readonly WorkflowFileStep[];
  /** Each step's `title` and `review`, by the step's index. */
  readonly stepAnnotations: readonly WorkflowStepAnnotation[];
  /**
   * The document Weft is handed: `name`, `trigger`, `steps`, and the schemas, when there are any,
   * as written but without the keys of the extended format (`title`, `review`, and a schedule's
   * `timezone`, `catchUp`, `name`, and `input`), which are Bureau's.
   */
  readonly document: WorkflowDocument;
}

/** What a caller supplies to write a file; Bureau sets `name` to the identifier. */
export interface WorkflowFileDefinition {
  /** See {@link WorkflowFileContents.title}. */
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly agent?: string | undefined;
  readonly paused?: boolean | undefined;
  /** See {@link WorkflowFileContents.inputSchema}. */
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
  /** See {@link WorkflowFileContents.outputSchema}. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  /** The trigger, as {@link WorkflowFileContents.trigger} reads it back. */
  readonly trigger: WorkflowFileTrigger;
  /** The steps, as {@link WorkflowFileContents.steps} reads them back. */
  readonly steps: readonly WorkflowFileStep[];
}

export type ParsedWorkflowFile =
  | { readonly ok: true; readonly file: WorkflowFileContents }
  | { readonly ok: false; readonly problem: WorkflowFileProblem };

/**
 * Why `id` cannot be a workflow identifier, or `undefined` when it can: an owner file's bare stem,
 * or, for a file of `plugin`'s read-only layer (COR-1873), `plugin:stem`.
 */
export function checkWorkflowIdentifier(
  id: string,
  plugin?: string,
): WorkflowFileProblem | undefined {
  const stem =
    plugin === undefined ? id : id.startsWith(`${plugin}:`) ? id.slice(plugin.length + 1) : '';
  if (id.length <= WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH && WORKFLOW_FILE_STEM_PATTERN.test(stem)) {
    return undefined;
  }
  return {
    code: 'invalid-identifier',
    message: `"${id}" is not a valid workflow identifier: it must match ${WORKFLOW_FILE_STEM_PATTERN.source}${plugin === undefined ? '' : ` after "${plugin}:"`} and be at most ${WORKFLOW_IDENTIFIER_MAXIMUM_LENGTH} characters.`,
  };
}

/** The SHA-256 of a file's bytes, hex: the hash `expectedHash` is compared against. */
export function hashWorkflowFileBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A document's Weft `workflowVersion`: `sha256:` and the hex SHA-256 of its canonical JSON. The
 * same value `workflowDocumentVersion` returns, computed without waiting, because a scan is
 * synchronous per file.
 */
export function workflowVersionOf(document: WorkflowDocument): string {
  // Weft derives the version from the document it is given, which carries the mapped handler names.
  return `sha256:${createHash('sha256')
    .update(canonicalWorkflowDocumentJson(toWeftDocument(document)))
    .digest('hex')}`;
}

/** Decode a file's bytes as UTF-8, or `undefined` when they are not valid UTF-8. */
export function decodeWorkflowFile(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The issues with an `agent` step's `input`, which Weft's document schema leaves to the host, and
 * whether any of them is a key this host does not know.
 */
function agentStepIssues(document: WorkflowDocument): {
  issues: WorkflowFileIssue[];
  unrecognizedKeys: boolean;
} {
  const issues: WorkflowFileIssue[] = [];
  let unrecognizedKeys = false;
  for (const { step, path } of workflowFileStepsInCanonicalOrder(document.steps)) {
    if (step.kind !== 'activity' || step.handler !== AGENT_STEP_HANDLER) continue;
    const inputPath = `${path}.input`;
    const input: unknown = step.input;
    if (!isPlainObject(input)) {
      issues.push({
        path: inputPath,
        message: 'an agent step needs an input of { agent, message }',
      });
      continue;
    }
    const extra = Object.keys(input).filter((key) => key !== 'agent' && key !== 'message');
    if (extra.length > 0) {
      unrecognizedKeys = true;
      issues.push({
        path: inputPath,
        message: `unknown key ${extra.map((key) => `"${key}"`).join(', ')}`,
      });
    }
    const agent = input['agent'];
    if (typeof agent !== 'string' || !AGENT_IDENTIFIER_PATTERN.test(agent)) {
      issues.push({ path: inputPath, message: '"agent" must be an agent identifier' });
    }
    if (typeof input['message'] !== 'string') {
      issues.push({ path: inputPath, message: '"message" must be a string' });
    }
  }
  return { issues, unrecognizedKeys };
}

/**
 * The issue with a schedule-triggered file whose `inputSchema` refuses what a fire starts its
 * instance with (COR-1927): the trigger's `input` (COR-2009), or `null` when it gives none. Such a
 * file would fail every fire with `input-invalid`, so it is refused when it is written instead. A
 * schema the limits already refused is judged by those, and a file with no schema accepts anything.
 * A refused `input` is reported at `trigger.input`; a refused `null` at `inputSchema`.
 */
function scheduleInputIssues(
  document: WorkflowDocument,
  writtenTrigger: unknown,
): WorkflowFileIssue[] {
  const schema = document.inputSchema;
  if (document.trigger.kind !== 'schedule' || schema === undefined) return [];
  if (workflowSchemaIssues('inputSchema', schema).length > 0) return [];
  const input = isPlainObject(writtenTrigger) ? (writtenTrigger['input'] ?? null) : null;
  const refused = inputSchemaIssues(schema, input);
  if (refused.length === 0) return [];
  const reasons = refused.map((issue) => issue.message).join('; ');
  return input === null
    ? [
        {
          path: 'inputSchema',
          message: `a schedule fire starts the workflow with no input, which is null, and this schema refuses it (${reasons}); give the trigger an "input" the schema accepts, accept null, or use another trigger`,
        },
      ]
    : [
        {
          path: 'trigger.input',
          message: `every schedule fire starts the workflow with this input, and the inputSchema refuses it (${reasons})`,
        },
      ];
}

/**
 * Whether Weft's structural schema refuses `documentInput` for a key it does not know, read from
 * the validator's own issue codes and not from its message text.
 */
function hasUnrecognizedDocumentKeys(documentInput: unknown): boolean {
  const result = workflowDocumentSchema.safeParse(documentInput);
  return !result.success && result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
}

/**
 * `document` with the version of every contributed activity its steps use written into
 * `activityVersions` (COR-1874): the version `host` has loaded for the handler, if it has one. A
 * file names an activity with no version and so floats with the plugin that contributes it; the
 * document Bureau registers pins what was loaded, so the revision it makes is that version's.
 */
function pinActivityVersions(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocument {
  const loaded = host.activityVersions;
  if (loaded === undefined) return document;
  const pins: Record<string, string> = {};
  for (const { step } of workflowFileStepsInCanonicalOrder(document.steps)) {
    if (step.kind !== 'activity') continue;
    const weftName = weftNameOf(step.handler);
    if (Object.hasOwn(loaded, weftName)) pins[step.handler] = loaded[weftName]!;
  }
  return Object.keys(pins).length === 0 ? document : { ...document, activityVersions: pins };
}

/**
 * `documentInput` without the keys of the extended format (COR-2009), which Weft's strict schema
 * would refuse: a `schedule` trigger's `timezone`, `catchUp`, `name`, and `input`, and each step's `title` and
 * `review`. Each is checked here first, into `issues`, and every step's annotation is returned by
 * index. Any other key is left in place, so Weft still refuses a key nobody knows.
 */
function stripExtensions(
  documentInput: Record<string, unknown>,
  issues: WorkflowFileIssue[],
): {
  readonly documentInput: Record<string, unknown>;
  readonly annotations: WorkflowStepAnnotation[];
} {
  const stripped: Record<string, unknown> = { ...documentInput };
  const trigger = documentInput['trigger'];
  if (isPlainObject(trigger) && trigger['kind'] === 'schedule') {
    const issue = scheduleTriggerExtensionIssue(trigger);
    if (issue !== undefined) issues.push({ path: 'trigger', message: issue });
    const { timezone: _timezone, catchUp: _catchUp, name: _name, input: _input, ...rest } = trigger;
    stripped['trigger'] = rest;
  }
  const annotations: WorkflowStepAnnotation[] = [];
  const steps = documentInput['steps'];
  if (Array.isArray(steps)) {
    const stripStep = (step: unknown, path: string): unknown => {
      if (!isPlainObject(step)) {
        return step;
      }
      const { title, review, ...rest } = step;
      if (Object.hasOwn(step, 'title') && !isTitle(title)) {
        issues.push({ path: `${path}.title`, message: TITLE_MESSAGE });
      }
      if (Object.hasOwn(step, 'review')) {
        if (step['kind'] !== 'await-signal') {
          issues.push({
            path: `${path}.review`,
            message: 'only an await-signal step can wait for a person',
          });
        } else if (review !== true) {
          issues.push({
            path: `${path}.review`,
            message: 'must be true, or left out for a step that waits for an outside signal',
          });
        }
      }
      if (rest['kind'] === 'branch' && isPlainObject(rest['cases'])) {
        rest['cases'] = Object.fromEntries(
          Object.entries(rest['cases']).map(([literal, nested]) => [
            literal,
            Array.isArray(nested)
              ? nested.map((child, index) =>
                  stripStep(child, `${path}.cases.${literal}[${String(index)}]`),
                )
              : nested,
          ]),
        );
        if (Array.isArray(rest['otherwise'])) {
          rest['otherwise'] = rest['otherwise'].map((child, index) =>
            stripStep(child, `${path}.otherwise[${String(index)}]`),
          );
        }
      } else if (rest['kind'] === 'map' && Array.isArray(rest['steps'])) {
        rest['steps'] = rest['steps'].map((child, index) =>
          stripStep(child, `${path}.steps[${String(index)}]`),
        );
      } else if (rest['kind'] === 'parallel' && isPlainObject(rest['branches'])) {
        rest['branches'] = Object.fromEntries(
          Object.entries(rest['branches']).map(([name, nested]) => [
            name,
            Array.isArray(nested)
              ? nested.map((child, index) =>
                  stripStep(child, `${path}.branches.${name}[${String(index)}]`),
                )
              : nested,
          ]),
        );
      }
      return rest;
    };
    stripped['steps'] = steps.map((step, index) => stripStep(step, `steps[${String(index)}]`));
    for (const { step } of workflowFileStepsInCanonicalOrder(steps as WorkflowFileStep[])) {
      annotations.push({
        title: isPlainObject(step) && isTitle(step['title']) ? step['title'] : null,
        review: isPlainObject(step) && step['review'] === true,
      });
    }
  }
  return { documentInput: stripped, annotations };
}

/**
 * Parse a workflow file's text as the workflow `id`, validating it against `host`. `plugin` names
 * the plugin whose read-only layer holds the file (COR-1873). Never throws: a file that cannot be
 * used comes back as a problem.
 */
export function parseWorkflowFile(
  id: string,
  text: string,
  host: DocumentWorkflowHost,
  plugin?: string,
): ParsedWorkflowFile {
  const identifierProblem = checkWorkflowIdentifier(id, plugin);
  if (identifierProblem !== undefined) return { ok: false, problem: identifierProblem };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: {
        code: 'invalid-json',
        message: `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problem: { code: 'invalid-json', message: 'The file must hold one JSON object.' },
    };
  }
  const { title, description, agent, paused, ...written } = value;
  const issues: WorkflowFileIssue[] = [];
  if (Object.hasOwn(value, 'title') && !isTitle(title)) {
    issues.push({ path: 'title', message: TITLE_MESSAGE });
  }
  const { documentInput, annotations } = stripExtensions(written, issues);
  if (
    Object.hasOwn(value, 'description') &&
    (typeof description !== 'string' ||
      description.trim() === '' ||
      description.length > WORKFLOW_DESCRIPTION_MAXIMUM_LENGTH)
  ) {
    issues.push({
      path: 'description',
      message: `must be a non-empty string of at most ${String(WORKFLOW_DESCRIPTION_MAXIMUM_LENGTH)} characters`,
    });
  }
  if (
    Object.hasOwn(value, 'agent') &&
    (typeof agent !== 'string' || !AGENT_IDENTIFIER_PATTERN.test(agent))
  ) {
    issues.push({ path: 'agent', message: 'must be an agent identifier' });
  }
  if (Object.hasOwn(value, 'paused') && typeof paused !== 'boolean') {
    issues.push({ path: 'paused', message: 'must be true or false' });
  }
  if (Object.hasOwn(documentInput, 'activityVersions')) {
    issues.push({
      path: 'activityVersions',
      message:
        'a workflow file does not pin activity versions: it names an activity as plugin:name, and Bureau pins the version that is loaded when it registers the file',
    });
  }
  let document: WorkflowDocument | undefined;
  let unrecognizedKeys = false;
  try {
    document = validateBureauWorkflowDocument(documentInput, host);
  } catch (error) {
    if (!(error instanceof WorkflowDocumentValidationError)) throw error;
    issues.push(...error.issues);
    unrecognizedKeys =
      hasUnrecognizedDocumentKeys(documentInput) ||
      triggerHasUnrecognizedKeys(documentInput['trigger']);
  }
  if (document !== undefined) {
    document = pinActivityVersions(document, host);
    if (document.name !== id) {
      issues.push({ path: 'name', message: `must equal the identifier "${id}"` });
    }
    const agentSteps = agentStepIssues(document);
    issues.push(...agentSteps.issues);
    unrecognizedKeys ||= agentSteps.unrecognizedKeys;
    // The shape is Weft's to judge (a JSON object); the limits are the answer schemas'.
    for (const key of ['inputSchema', 'outputSchema'] as const) {
      if (document[key] !== undefined) issues.push(...workflowSchemaIssues(key, document[key]));
    }
    issues.push(...scheduleInputIssues(document, written['trigger']));
  }
  if (issues.length > 0 || document === undefined) {
    return {
      ok: false,
      problem: {
        code: 'invalid-document',
        message: `Invalid workflow file: ${issues
          .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
          .join('; ')}`,
        issues,
        ...(unrecognizedKeys ? { unrecognizedKeys: true as const } : {}),
      },
    };
  }
  return {
    ok: true,
    file: {
      title: typeof title === 'string' ? title : null,
      description: typeof description === 'string' ? description : null,
      agent: typeof agent === 'string' ? agent : null,
      paused: paused === true,
      inputSchema: document.inputSchema ?? null,
      outputSchema: document.outputSchema ?? null,
      // A valid document had a trigger object and a steps array, as written.
      trigger: written['trigger'] as WorkflowFileTrigger,
      steps: written['steps'] as WorkflowFileStep[],
      stepAnnotations: annotations,
      document,
    },
  };
}

/**
 * The text of a file for `definition`, as the workflow `id`: two-space JSON with a trailing
 * newline, keys in the order the workflow page's Code tab shows them: `name`, `title`,
 * `description`, `agent`, `paused`, `trigger`, `inputSchema`, `outputSchema`, `steps`.
 */
export function serializeWorkflowFile(id: string, definition: WorkflowFileDefinition): string {
  const body: Record<string, unknown> = { name: id };
  if (definition.title !== undefined) body['title'] = definition.title;
  if (definition.description !== undefined) body['description'] = definition.description;
  if (definition.agent !== undefined) body['agent'] = definition.agent;
  if (definition.paused !== undefined) body['paused'] = definition.paused;
  body['trigger'] = definition.trigger;
  if (definition.inputSchema !== undefined) body['inputSchema'] = definition.inputSchema;
  if (definition.outputSchema !== undefined) body['outputSchema'] = definition.outputSchema;
  body['steps'] = definition.steps;
  const knownKeys = new Set([
    'title',
    'description',
    'agent',
    'paused',
    'trigger',
    'inputSchema',
    'outputSchema',
    'steps',
  ]);
  for (const [key, value] of Object.entries(definition)) {
    if (!knownKeys.has(key) && value !== undefined) body[key] = value;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Why a read or write of a workflow file was refused, beyond the problem codes. */
export type WorkflowFileErrorCode =
  | WorkflowFileProblemCode
  | 'workflow-file-not-found'
  | 'workflow-file-exists'
  | 'workflow-file-changed'
  | 'workflow-file-read-only';

/** A write or read of a workflow file that was refused. `problem` carries the detail, if any. */
export class WorkflowFileError extends Error {
  readonly code: WorkflowFileErrorCode;
  readonly problem: WorkflowFileProblem | undefined;

  constructor(code: WorkflowFileErrorCode, message: string, problem?: WorkflowFileProblem) {
    super(message);
    this.name = 'WorkflowFileError';
    this.code = code;
    this.problem = problem;
  }
}

/**
 * A write that lost to the file's current state: `create` found the file, or `update`, `pause`,
 * `resume`, or `delete` found bytes that do not hash to `expectedHash`. `currentHash` is the hash
 * of what is there.
 */
export class WorkflowFileConflictError extends WorkflowFileError {
  readonly currentHash: string | undefined;

  constructor(
    code: 'workflow-file-exists' | 'workflow-file-changed',
    message: string,
    currentHash?: string,
  ) {
    super(code, message);
    this.name = 'WorkflowFileConflictError';
    this.currentHash = currentHash;
  }
}
