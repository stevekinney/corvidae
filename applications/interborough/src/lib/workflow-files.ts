/**
 * The browser's view of the Bureau's workflow files: the operations `bureau.workflows.*`
 * (COR-1527, COR-1528), through the generated client, and the text of a file turned into what an
 * update sends.
 *
 * A workflow is a JSON file, and its identifier is the filename without `.json`, which is also the
 * name of its type in the engine. Every write names the `hash` of the file the caller read, so a
 * file that changed since is refused instead of overwritten; the fault is the one agent files use
 * (`agentFaultOf`), because the wire codes are the same.
 */
import { HttpClientError } from '@lostgradient/weft/client';
import { z } from 'zod';

import { bureauClient, type BureauInput, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

type WorkflowJson = Exclude<BureauInput<'bureau.workflows.start'>['input'], undefined>;

function isWorkflowJson(value: unknown): value is WorkflowJson {
  return z.json().safeParse(value).success;
}

/** Preserve the same JSON serialization the transport applies, including own `__proto__` keys. */
function workflowJson(value: unknown): WorkflowJson {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Workflow input must be JSON.');
  const parsed: unknown = JSON.parse(serialized);
  if (!isWorkflowJson(parsed)) throw new TypeError('Workflow input must be JSON.');
  return parsed;
}

type ListedWorkflow = BureauOutput<'bureau.workflows.list'>['workflows'][number];
type CodeEntry = Extract<ListedWorkflow, { readonly kind: 'code' }>;
type FileEntry = Exclude<ListedWorkflow, { readonly kind: 'code' }>;

/**
 * One entry of `bureau.workflows.list`: a file, with whether the Bureau could use it. `title` is
 * the name a person reads, when the file gives one (an invalid file has none); `inputSchema` and
 * `outputSchema` are the JSON Schemas an instance's input and result must satisfy, or `null` when
 * the file declares none; `trigger` is the trigger as written; `steps` are the steps as written,
 * each agent step naming the agent it runs in `input.agent`; `listener` is what the file's
 * contributed trigger is doing, or `null` for a built-in trigger kind, a file that is not ready, and
 * a listener whose first start has not settled; `runs` are the counts of a file that loaded, and
 * `null` for one the Bureau cannot use.
 */
export type WorkflowFileListing = AbsentTolerant<FileEntry>;

/**
 * A file as a Bureau that predates `title`, `steps`, `listener` or `outputName` (COR-2424) shows
 * it: without them.
 */
type AbsentTolerant<File extends Pick<FileEntry, 'title' | 'steps' | 'listener' | 'outputName'>> =
  Omit<File, 'title' | 'steps' | 'listener' | 'outputName'> & {
    readonly title?: File['title'] | undefined;
    readonly steps?: File['steps'] | undefined;
    readonly listener?: File['listener'] | undefined;
    readonly outputName?: File['outputName'] | undefined;
  };

/**
 * A problem the Bureau found in a workflow file: a code, a message, and the field-level issues
 * behind it when there are any.
 */
export type WorkflowProblem = NonNullable<WorkflowFileListing['problem']>;

/**
 * What a ready file's contributed trigger is doing (COR-2165, COR-2167, COR-2168): `listening`
 * once its `start` resolved, `ready` for a kind that only receives, `standby` while another Bureau
 * sharing the storage runs it, `waiting-for-secret`, `failed` with a `code` and, for a start that
 * threw, when it is tried again, and `stopped` for a paused file.
 */
export type WorkflowListener = NonNullable<WorkflowFileListing['listener']>;

/**
 * How busy a workflow is, as the Bureau counts its instances: the instances that have not finished,
 * those that began in the last 24 hours, and when the newest began (ISO 8601), or `null` for a
 * workflow that has not run.
 */
export type WorkflowRunCounts = NonNullable<WorkflowFileListing['runs']>;

/**
 * A code workflow a plugin contributed, which the list shows after the files with an explicit
 * `kind` and none of a file's members (no state, hash or trigger). {@link listWorkflowFiles} leaves
 * it out, so the workflow pages show files; the builder reads the code workflows from the catalog.
 * `id` is `plugin:name`, the `workflow` of a `workflow` step.
 */
export type CodeWorkflowListing = CodeEntry;

/** One file as `bureau.workflows.get` shows it, with its text and its live schedule. */
export type WorkflowFileDetail = AbsentTolerant<BureauOutput<'bureau.workflows.get'>>;

/**
 * A workflow that code registered, as `bureau.workflows.internal.get` shows it. `source.text` is
 * the workflow's description followed by its registered contract as JSON; the code is not exposed.
 */
export type CodeWorkflow = BureauOutput<'bureau.workflows.internal.get'>;

/** What starting a workflow answers: the new instance's identifier and the revision it runs. */
export type WorkflowStartResult = BureauOutput<'bureau.workflows.start'>;

/** What a write answers: the workflow's identifier and the hash of the file now on disk. */
export type WorkflowWriteResult = BureauOutput<'bureau.workflows.create'>;

/**
 * The instances a signal started and was delivered to, and the workflows that refused its payload
 * (`rejected`: the matching workflows whose `inputSchema` the payload broke, for which nothing
 * started).
 */
export type SignalResult = BureauOutput<'bureau.workflows.signal'>;

/** The largest page `bureau.workflows.list` answers. */
const LISTING_PAGE_SIZE = 100;

/**
 * Every workflow file, `ready` and `invalid` alike. It follows the pages to the end. The counts of
 * each file's instances are asked for only by a caller that shows them, because the Bureau reads
 * the engine for each one.
 */
export async function listWorkflowFiles(
  options?: Options & { readonly includeRuns?: boolean },
): Promise<readonly WorkflowFileListing[]> {
  const { files } = await listWorkflowEntries(options);
  return files;
}

/** Everything `bureau.workflows.list` answers: the files, and the code workflows plugins contributed. */
export async function listWorkflowEntries(
  options?: Options & { readonly includeRuns?: boolean },
): Promise<{
  readonly files: readonly WorkflowFileListing[];
  readonly code: readonly CodeWorkflowListing[];
}> {
  const listings: WorkflowFileListing[] = [];
  const code: CodeWorkflowListing[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: BureauOutput<'bureau.workflows.list'> = await bureauClient['bureau.workflows.list'](
      {
        limit: LISTING_PAGE_SIZE,
        offset,
        ...(options?.includeRuns === true ? { includeRuns: true } : {}),
      },
      options,
    );
    for (const entry of page.workflows) {
      if ('kind' in entry) code.push(entry);
      else listings.push(entry);
    }
    offset = page.nextOffset;
  }
  return { files: listings, code };
}

/** One workflow file. A file that is gone is a `NotFound` fault. */
export async function getWorkflowFile(id: string, options?: Options): Promise<WorkflowFileDetail> {
  return bureauClient['bureau.workflows.get']({ id }, options);
}

/** The run revisions together with the count of every saved version, including unrun ones. */
export async function getWorkflowRevisionSummary(
  id: string,
  options?: Options,
): Promise<Pick<BureauOutput<'bureau.workflows.revisions'>, 'revisions' | 'savedVersionCount'>> {
  return bureauClient['bureau.workflows.revisions']({ id }, options);
}

/**
 * The steps of the newest version the Bureau saved of a workflow's file, as `bureau.workflows.history`
 * lists them. Unlike {@link getWorkflowRevisionSummary} it holds a version that never ran, and it still
 * answers for a workflow whose file cannot load or was deleted, so a schedule row can say which
 * agent such a workflow ran. `undefined` when the workflow has no saved version.
 */
export async function getLatestSavedSteps(
  id: string,
  options?: Options,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const [latest] = await listWorkflowSavedVersions(id, options);
  return latest?.steps;
}

/** One saved version of a file, including versions that never ran. */
export type SavedWorkflowVersion = BureauOutput<'bureau.workflows.history'>['revisions'][number];

/** The versions of the workflow's file, newest first. */
export async function listWorkflowSavedVersions(
  id: string,
  options?: Options,
): Promise<readonly SavedWorkflowVersion[]> {
  const { revisions } = await bureauClient['bureau.workflows.history']({ id }, options);
  return revisions;
}

/**
 * One saved version of a workflow: its number (`1.2.0`) and the engine revision it registered as,
 * and the version's steps as written, titles included, which the engine's revision drops.
 */
export type WorkflowVersionLabel = Pick<
  SavedWorkflowVersion,
  'version' | 'current' | 'workflowVersion'
> & {
  readonly steps?: SavedWorkflowVersion['steps'] | undefined;
};

/**
 * The saved versions of a workflow, newest first, as `bureau.workflows.history` numbers them
 * (`1.0.0`, `1.1.0`, …), each with the engine revision it registered as, so the run page can say
 * "1.2.0" for the revision a run ran (COR-2424).
 */
export async function listWorkflowVersionLabels(
  id: string,
  options?: Options,
): Promise<readonly WorkflowVersionLabel[]> {
  return listWorkflowSavedVersions(id, options);
}

/** A code-defined workflow's description and registered contract. Anything the caller may not read is a `NotFound` fault. */
export async function getCodeWorkflow(id: string, options?: Options): Promise<CodeWorkflow> {
  return bureauClient['bureau.workflows.internal.get']({ id }, options);
}

/**
 * Starts one instance of a ready, unpaused workflow file with `input`, which the Bureau checks
 * against the file's `inputSchema` before anything is created (`InvalidParams`, with the issues).
 */
export async function startWorkflowFile(
  id: string,
  input: unknown,
  idempotencyKey: string | undefined,
  options?: Options,
): Promise<WorkflowStartResult> {
  return bureauClient['bureau.workflows.start'](
    {
      id,
      surface: 'web',
      ...(input === undefined ? {} : { input: workflowJson(input) }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    options,
  );
}

/**
 * What an update sends: the document without its `name`, which the Bureau sets to the identifier.
 * The update schema rejects a key it does not know, so `name` is stripped and every other key is
 * kept as it was written, so the Bureau can refuse one that is wrong.
 */
export type WorkflowDefinitionInput = Readonly<Record<string, unknown>>;

/**
 * The definition as the operations take it. It is a document as the editor's text holds it, so
 * its static type names no member; the Bureau validates it and refuses one that is wrong.
 */
function wireDefinition(
  definition: WorkflowDefinitionInput,
): BureauInput<'bureau.workflows.create'>['definition'] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return definition as BureauInput<'bureau.workflows.create'>['definition'];
}

/** Writes a new workflow file for `id`, which a taken identifier refuses (`Conflict`). */
export async function createWorkflowFile(
  id: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return bureauClient['bureau.workflows.create'](
    { id, definition: wireDefinition(definition) },
    options,
  );
}

type RunSummary = BureauOutput<'bureau.workflows.runs.list'>['runs'][number];

const validationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), id: z.string(), hash: z.string() }),
  z.object({
    status: z.literal('invalid'),
    code: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
  z.object({
    status: z.literal('conflict'),
    id: z.string(),
    reason: z.string(),
    currentHash: z.string().optional(),
  }),
]);

/** What `bureau.workflows.validate` answers: the draft would be written, is refused with issues, or conflicts. */
export type WorkflowValidation = z.infer<typeof validationSchema>;

/**
 * Asks the Bureau whether a draft would be written, with the same checks as a write and without
 * writing (`bureau.workflows.validate`): `id` alone for a new workflow, with `expectedHash` for an
 * edit of the file that hashes to it. A refusal names the issues by their paths (COR-2432).
 */
export async function validateWorkflowDefinition(
  draft: {
    readonly id?: string;
    readonly expectedHash?: string;
    readonly definition: WorkflowDefinitionInput;
  },
  options?: Options,
): Promise<WorkflowValidation> {
  return validationSchema.parse(
    await bureauClient['bureau.workflows.validate'](
      {
        ...(draft.id === undefined ? {} : { id: draft.id }),
        ...(draft.expectedHash === undefined ? {} : { expectedHash: draft.expectedHash }),
        definition: wireDefinition(draft.definition),
      },
      options,
    ),
  );
}

/**
 * One workflow-file run summary returned by the Bureau list operation, as
 * `bureau.workflows.runs.list` summarises an instance. Older fixtures and Bureau versions omit
 * `origin`, which {@link workflowRunOf} defaults to `null`.
 */
export type WorkflowFileRun = Omit<RunSummary, 'origin'> & {
  readonly origin?: RunSummary['origin'] | undefined;
};

/** One workflow-file run detail returned by the Bureau get operation, with what started it and how it ended. */
export type WorkflowFileRunDetail = Omit<
  BureauOutput<'bureau.workflows.runs.get'>,
  'origin' | 'result' | 'error' | 'finishReason' | 'outputName'
> & {
  readonly origin?: RunSummary['origin'] | undefined;
  /** The Bureau answers `null` for a result or an error the instance has not got. */
  readonly result?: unknown;
  readonly error?: string | null | undefined;
  readonly finishReason?: BureauOutput<'bureau.workflows.runs.get'>['finishReason'] | undefined;
  /** COR-2424: the name the version the run ran gives what it produces; a Bureau before it says none. */
  readonly outputName?: string | null | undefined;
};

/**
 * A run as a Bureau that predates `origin` has it: with no origin. The server's schema always sends
 * the field, so this default belongs to the browser, applied to the typed result.
 */
export function workflowRunOf<Run extends { readonly origin?: RunSummary['origin'] | undefined }>(
  run: Run,
): Run & { readonly origin: RunSummary['origin'] } {
  return { ...run, origin: run.origin ?? null };
}

/**
 * One instance of a workflow file, by the identifier `bureau.workflows.start` or a trigger gave it.
 * The Bureau answers for the instance whether or not the engine behind the console holds it, so a
 * run page that cannot read the engine can still say what the run is. A missing instance is a
 * not-found fault.
 */
export async function getWorkflowFileRun(
  runId: string,
  options?: Options,
): Promise<WorkflowFileRunDetail> {
  return workflowRunOf(await bureauClient['bureau.workflows.runs.get']({ runId }, options));
}

/** What `bureau.workflows.runs.retry` answers: the instance is running again from `step`. */
export type WorkflowRunRetry = BureauOutput<'bureau.workflows.runs.retry'>;

/**
 * Runs a failed instance of a workflow file again from the step it failed at, in place and on the
 * version it ran (COR-2424, `bureau.workflows.runs.retry`). `step` is counted from one and must be
 * the step it failed at; `retryId` makes a repeat of this request answer what the first did. A
 * refusal is an `Unprocessable` fault whose `data.reason` says why.
 */
export async function retryWorkflowRun(
  runId: string,
  step: number,
  retryId: string,
  options?: Options,
): Promise<WorkflowRunRetry> {
  return bureauClient['bureau.workflows.runs.retry']({ runId, step, retryId }, options);
}

/** An instance's history, as `bureau.workflows.runs.history` sanitizes it. */
export type WorkflowRunHistory = BureauOutput<'bureau.workflows.runs.history'>;

/**
 * One event of an instance's history; its `step` is the step the event belongs to, by its index
 * from zero, or `null`.
 */
export type WorkflowRunHistoryEvent = WorkflowRunHistory['events'][number];

/**
 * The bounded, sanitized step history of one instance of a workflow file
 * (`bureau.workflows.runs.history`): which step it started, when, and what each activity was.
 * A not-found fault when the Bureau does not hold the instance.
 */
export async function getWorkflowRunHistory(
  runId: string,
  options?: Options,
): Promise<WorkflowRunHistory> {
  return bureauClient['bureau.workflows.runs.history']({ runId, limit: 500 }, options);
}

/** The newest `limit` instances of one workflow file and whether it has an older page. */
export async function listWorkflowFileRuns(
  id: string,
  limit: number,
  options?: Options,
): Promise<{ readonly runs: readonly WorkflowFileRun[]; readonly hasMore: boolean }> {
  const page = await bureauClient['bureau.workflows.runs.list']({ workflow: id, limit }, options);
  return { runs: page.runs.map(workflowRunOf), hasMore: page.nextOffset !== null };
}

/** Replaces the workflow's file, if it still hashes to `expectedHash`. */
export async function updateWorkflowFile(
  id: string,
  expectedHash: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return bureauClient['bureau.workflows.update'](
    { id, expectedHash, definition: wireDefinition(definition) },
    options,
  );
}

/**
 * What saving a definition would do, as `bureau.workflows.impact` answers it: the `version` the
 * save makes (`null` when it changes nothing that makes one), the `previousVersion` it replaces,
 * each change with whether it is `breaking`, the verdict, and how many runs are `inFlight` (`null`
 * when the caller may not count them).
 */
export type WorkflowImpact = BureauOutput<'bureau.workflows.impact'>;

/** One change {@link WorkflowImpact} lists. */
export type WorkflowImpactChange = WorkflowImpact['changes'][number];

/** What saving `definition` as the workflow `id` would do. It writes nothing. */
export async function getWorkflowImpact(
  id: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowImpact> {
  return bureauClient['bureau.workflows.impact'](
    { id, definition: wireDefinition(definition) },
    options,
  );
}

/** Sets `paused: true` in the workflow's file, if it still hashes to `expectedHash`. */
export async function pauseWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return bureauClient['bureau.workflows.pause']({ id, expectedHash }, options);
}

/**
 * Starts the failed listener of the workflow `id`'s contributed trigger at once
 * (`bureau.workflows.triggers.retry`, COR-2166), and resolves with what it is doing once the
 * attempt has settled: `listening`, `failed` again with its next `retryAt`, or `standby` when
 * another Bureau runs it.
 */
export async function retryWorkflowTrigger(
  id: string,
  options?: Options,
): Promise<WorkflowListener> {
  const answer = await bureauClient['bureau.workflows.triggers.retry']({ id }, options);
  return answer.listener;
}

/** Sets `paused: false` in the workflow's file, if it still hashes to `expectedHash`. */
export async function resumeWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return bureauClient['bureau.workflows.resume']({ id, expectedHash }, options);
}

/** Deletes the workflow's file, if it still hashes to `expectedHash`. */
export async function deleteWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return bureauClient['bureau.workflows.delete']({ id, expectedHash }, options);
}

/**
 * Delivers a signal to the running instances waiting for it, and starts the workflows whose trigger
 * it is. An absent payload is sent as none.
 */
export async function signalWorkflows(
  input: { readonly name: string; readonly payload?: unknown },
  options?: Options,
): Promise<SignalResult> {
  const params =
    input.payload === undefined
      ? { name: input.name }
      : { name: input.name, payload: workflowJson(input.payload) };
  return bureauClient['bureau.workflows.signal'](params, options);
}

/**
 * Whether a write answered that the Bureau changed the file and the engine or the schedule could
 * not follow (`Unavailable`, `data.reason` `workflow-apply-failed`). The change is on disk, so the
 * hash the caller holds is old, and the write must not be shown as one that did not happen.
 */
export function isApplyFailure(error: unknown): boolean {
  return error instanceof HttpClientError && error.data?.['reason'] === 'workflow-apply-failed';
}

/** Whether a create answered that the identifier is taken (`Conflict`, `data.reason` `workflow-file-exists`). */
export function isIdentifierTaken(error: unknown): boolean {
  return error instanceof HttpClientError && error.data?.['reason'] === 'workflow-file-exists';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const documentSchema = z.looseObject({
  description: z.string().optional(),
  agent: z.string().optional(),
  paused: z.boolean().optional(),
  trigger: z.looseObject({ kind: z.string() }),
  steps: z.array(z.looseObject({ kind: z.string() })),
});

/** A workflow document as the page reads it to show: its trigger, its steps, and its agent. */
export type WorkflowDocument = z.infer<typeof documentSchema>;

/**
 * The document a file's text holds, for showing its trigger and steps, or `undefined` when the
 * text is missing or is not one. The Bureau decides whether a document is valid; this only reads.
 */
export function parseWorkflowText(text: string | null): WorkflowDocument | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = documentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** What turning a file's text into an update gave: the definition, or why the text cannot be sent. */
export type UpdateDefinition =
  | { readonly ok: true; readonly definition: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'not-json' | 'not-object' };

/** The text of an editor as an update's definition: parsed, and without its `name`. */
export function updateDefinitionFromText(text: string): UpdateDefinition {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isRecord(value)) return { ok: false, reason: 'not-object' };
  const { name: _name, ...definition } = value;
  return { ok: true, definition };
}

/** What turning a new workflow's text into a create gave: the identifier and definition, or why not. */
export type CreateDefinition =
  | { readonly ok: true; readonly id: string; readonly definition: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: 'not-json' | 'not-object' | 'no-name' | 'invalid-name' | 'reserved-name';
    };

/** What a workflow's identifier must look like: the Bureau's rule, checked before the call. */
const IDENTIFIER_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const IDENTIFIER_MAXIMUM_LENGTH = 64;

/**
 * `/workflows/new` is the address of the page that creates a workflow, so a workflow called `new`
 * could never be opened.
 */
export const RESERVED_WORKFLOW_IDENTIFIER = 'new';

/**
 * The text of the new-workflow editor as a create: its `name` is the identifier, so it is read and
 * not sent, as an update strips it. The Bureau still decides whether the rest is a workflow.
 */
export function createDefinitionFromText(text: string): CreateDefinition {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isRecord(value)) return { ok: false, reason: 'not-object' };
  const { name, ...definition } = value;
  if (name === undefined) return { ok: false, reason: 'no-name' };
  if (
    typeof name !== 'string' ||
    name.length > IDENTIFIER_MAXIMUM_LENGTH ||
    !IDENTIFIER_PATTERN.test(name)
  ) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (name === RESERVED_WORKFLOW_IDENTIFIER) return { ok: false, reason: 'reserved-name' };
  return { ok: true, id: name, definition };
}
