/**
 * The browser's view of the Bureau's workflow files: the operations `bureau.workflows.*`
 * (COR-1527, COR-1528), parsed at the boundary, and the text of a file turned into what an update
 * sends.
 *
 * A workflow is a JSON file, and its identifier is the filename without `.json`, which is also the
 * name of its type in the engine. Every write names the `hash` of the file the caller read, so a
 * file that changed since is refused instead of overwritten; the fault is the one agent files use
 * (`agentFaultOf`), because the wire codes are the same.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const problemSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});

/**
 * A problem the Bureau found in a workflow file: a code, a message, and the field-level issues
 * behind it when there are any.
 */
export type WorkflowProblem = z.infer<typeof problemSchema>;

/** A JSON Schema as a workflow file declares it. */
const jsonSchemaField = z.record(z.string(), z.unknown());

const fileSchema = z.object({
  id: z.string(),
  state: z.enum(['ready', 'invalid']),
  owner: z.string(),
  hash: z.string().nullable(),
  /** The name a person reads, when the file gives one; an invalid file has none. */
  title: z.string().nullable().optional(),
  /** What the workflow is for, in a sentence, when the file says. */
  description: z.string().nullable(),
  agent: z.string().nullable(),
  paused: z.boolean(),
  /** The JSON Schema an instance's input must satisfy, or `null` when the file declares none. */
  inputSchema: jsonSchemaField.nullable(),
  /** The JSON Schema an instance's result must satisfy, or `null` when the file declares none. */
  outputSchema: jsonSchemaField.nullable(),
  version: z.string().nullable(),
  /** The trigger as written (`kind`, and `spec` or `name`), for a file that loaded. */
  trigger: z.record(z.string(), z.unknown()).nullable(),
  /** The steps as written, for a file that loaded; each agent step names the agent it runs in `input.agent`. */
  steps: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  problem: problemSchema.nullable(),
});

const runCountsSchema = z.object({
  /** Instances that have not finished. */
  active: z.number(),
  /** Instances that began in the last 24 hours. */
  last24Hours: z.number(),
  /** When the newest instance began (ISO 8601), or `null` for a workflow that has not run. */
  lastRunAt: z.string().nullable(),
});

/** How busy a workflow is, as the Bureau counts its instances. */
export type WorkflowRunCounts = z.infer<typeof runCountsSchema>;

const listingSchema = fileSchema.extend({
  /** The counts of a file that loaded, and `null` for one the Bureau cannot use. */
  runs: runCountsSchema.nullable(),
});

/** One entry of `bureau.workflows.list`: a file, with whether the Bureau could use it. */
export type WorkflowFileListing = z.infer<typeof listingSchema>;

/**
 * A code workflow a plugin contributed, which the list shows after the files with an explicit
 * `kind` and none of a file's members (no state, hash or trigger). {@link listWorkflowFiles} leaves
 * it out, so the workflow pages show files; {@link listCodeWorkflows} reads it for the builder.
 */
const codeListingSchema = z.object({
  kind: z.literal('code'),
  id: z.string(),
  name: z.string(),
  title: z.string(),
  plugin: z.string(),
  version: z.string(),
});

/** A code workflow a plugin contributed: `id` is `plugin:name`, the `workflow` of a `workflow` step. */
export type CodeWorkflowListing = z.infer<typeof codeListingSchema>;

const detailSchema = fileSchema.extend({
  text: z.string().nullable(),
  schedule: z
    .object({
      id: z.string(),
      status: z.enum(['active', 'paused']),
      nextFireAt: z.string().nullable(),
    })
    .nullable(),
});

/** One file as `bureau.workflows.get` shows it, with its text and its live schedule. */
export type WorkflowFileDetail = z.infer<typeof detailSchema>;

/** Weft's verdict on whether a revision is compatible with the workflow's current revision. */
const compatibilitySchema = z.discriminatedUnion('compatible', [
  z.object({ compatible: z.literal(true) }),
  z.object({ compatible: z.literal(false), reasons: z.array(z.string()) }),
]);

/** A revision's compatibility with the current revision: `{ compatible: true }`, or the reasons it is not. */
export type WorkflowCompatibility = z.infer<typeof compatibilitySchema>;

const revisionsSchema = z.object({
  revisions: z.array(
    z.object({
      workflowVersion: z.string(),
      firstRunAt: z.string(),
      lastRunAt: z.string(),
      document: z.object({
        name: z.string(),
        trigger: z.record(z.string(), z.unknown()),
        steps: z.array(z.record(z.string(), z.unknown())),
        inputSchema: jsonSchemaField.nullable(),
        outputSchema: jsonSchemaField.nullable(),
      }),
      /** The verdict against the current revision, or `null` when there is no current revision to compare with. */
      compatibility: compatibilitySchema.nullable(),
    }),
  ),
});

/** A version of the workflow's document that has run. */
export type WorkflowRevision = z.infer<typeof revisionsSchema>['revisions'][number];

const codeWorkflowSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  version: z.string().nullable(),
  source: z.object({ kind: z.literal('code'), text: z.string() }),
});

/**
 * A workflow that code registered, as `bureau.workflows.internal.get` shows it. `source.text` is
 * the workflow's description followed by its registered contract as JSON; the code is not exposed.
 */
export type CodeWorkflow = z.infer<typeof codeWorkflowSchema>;

const startResultSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  workflowVersion: z.string(),
});

/** What starting a workflow answers: the new instance's identifier and the revision it runs. */
export type WorkflowStartResult = z.infer<typeof startResultSchema>;

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

/** What a write answers: the workflow's identifier and the hash of the file now on disk. */
export type WorkflowWriteResult = z.infer<typeof writeResultSchema>;

const signalResultSchema = z.object({
  started: z.array(z.string()),
  delivered: z.array(z.string()),
  /** The matching workflows whose `inputSchema` the payload broke: nothing started for them. */
  rejected: z.array(
    z.object({
      id: z.string(),
      issues: z.array(
        z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
      ),
    }),
  ),
});

/** The instances a signal started and was delivered to, and the workflows that refused its payload. */
export type SignalResult = z.infer<typeof signalResultSchema>;

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

/**
 * The code workflows plugins contributed, from the same list as the files. A `workflow` step names
 * one by its `id` (`plugin:name`), and `title` is what the builder calls it.
 */
export async function listCodeWorkflows(
  options?: Options,
): Promise<readonly CodeWorkflowListing[]> {
  const { code } = await listWorkflowEntries(options);
  return code;
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
  const pageSchema = z.object({
    workflows: z.array(z.union([codeListingSchema, listingSchema])),
    nextOffset: z.number().nullable(),
  });
  while (offset !== null) {
    const page: z.infer<typeof pageSchema> = pageSchema.parse(
      await callBureau(
        'bureau.workflows.list',
        {
          limit: LISTING_PAGE_SIZE,
          offset,
          ...(options?.includeRuns === true ? { includeRuns: true } : {}),
        },
        options,
      ),
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
  return detailSchema.parse(await callBureau('bureau.workflows.get', { id }, options));
}

/** The versions of the workflow that have run, most recently run first. */
export async function listWorkflowRevisions(
  id: string,
  options?: Options,
): Promise<readonly WorkflowRevision[]> {
  return revisionsSchema.parse(await callBureau('bureau.workflows.revisions', { id }, options))
    .revisions;
}

const historySchema = z.object({
  revisions: z.array(
    z.object({
      current: z.boolean(),
      steps: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

/**
 * The steps of the newest version the Bureau saved of a workflow's file, as `bureau.workflows.history`
 * lists them. Unlike {@link listWorkflowRevisions} it holds a version that never ran, and it still
 * answers for a workflow whose file cannot load or was deleted, so a schedule row can say which
 * agent such a workflow ran. `undefined` when the workflow has no saved version.
 */
export async function getLatestSavedSteps(
  id: string,
  options?: Options,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const { revisions } = historySchema.parse(
    await callBureau('bureau.workflows.history', { id }, options),
  );
  return revisions[0]?.steps;
}

/** A code-defined workflow's description and registered contract. Anything the caller may not read is a `NotFound` fault. */
export async function getCodeWorkflow(id: string, options?: Options): Promise<CodeWorkflow> {
  return codeWorkflowSchema.parse(
    await callBureau('bureau.workflows.internal.get', { id }, options),
  );
}

/**
 * Starts one instance of a ready, unpaused workflow file with `input`, which the Bureau checks
 * against the file's `inputSchema` before anything is created (`InvalidParams`, with the issues).
 */
export async function startWorkflowFile(
  id: string,
  input: unknown,
  options?: Options,
): Promise<WorkflowStartResult> {
  return startResultSchema.parse(
    await callBureau(
      'bureau.workflows.start',
      { id, surface: 'web', ...(input === undefined ? {} : { input }) },
      options,
    ),
  );
}

/**
 * What an update sends: the document without its `name`, which the Bureau sets to the identifier.
 * The update schema rejects a key it does not know, so `name` is stripped and every other key is
 * kept as it was written, so the Bureau can refuse one that is wrong.
 */
export type WorkflowDefinitionInput = Readonly<Record<string, unknown>>;

/** Writes a new workflow file for `id`, which a taken identifier refuses (`Conflict`). */
export async function createWorkflowFile(
  id: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.workflows.create', { id, definition }, options),
  );
}

const runSummarySchema = z.object({
  id: z.string(),
  workflow: z.string(),
  workflowVersion: z.string(),
  status: z.enum([
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
    'timed-out',
    'suspended',
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
  origin: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('chat'),
        contextId: z.string(),
        agentName: z.string(),
        principal: z.string(),
      }),
      z.object({
        kind: z.literal('person'),
        principal: z.string(),
        surface: z.enum(['web', 'palette', 'api']),
      }),
      z.object({
        kind: z.literal('schedule'),
        scheduleId: z.string(),
        fireId: z.string(),
        manual: z.literal(true).optional(),
      }),
      z.object({ kind: z.literal('api') }),
      z.object({
        kind: z.literal('agent'),
        parentRunId: z.string(),
        parentContextId: z.string().optional(),
        agentName: z.string(),
        toolCallId: z.string().optional(),
      }),
      z.object({ kind: z.literal('agent-run'), runId: z.string(), agentId: z.string() }),
      z.object({ kind: z.literal('goal'), goalRunId: z.string(), attemptId: z.string() }),
      z.object({ kind: z.literal('parent'), parentRunId: z.string() }),
      z.object({ kind: z.literal('system') }),
    ])
    .nullable()
    .default(null),
});

/** One instance of a workflow file, as `bureau.workflows.runs.list` summarises it. */
type ParsedWorkflowFileRun = z.infer<typeof runSummarySchema>;
/** One workflow-file run summary returned by the Bureau list operation. */
export type WorkflowFileRun = Omit<ParsedWorkflowFileRun, 'origin'> & {
  /** Older fixtures and Bureau versions omit this field; the decoder defaults it to `null`. */
  readonly origin?: ParsedWorkflowFileRun['origin'];
};

const runDetailSchema = runSummarySchema.extend({
  trigger: z.unknown(),
  // The Bureau answers `null` for a result or an error the instance has not got.
  result: z.unknown().optional(),
  error: z.string().nullable().optional(),
  finishReason: z.string().nullable().optional(),
});

/** One instance of a workflow file with what started it and how it ended (`bureau.workflows.runs.get`). */
type ParsedWorkflowFileRunDetail = z.infer<typeof runDetailSchema>;
/** One workflow-file run detail returned by the Bureau get operation. */
export type WorkflowFileRunDetail = Omit<ParsedWorkflowFileRunDetail, 'origin'> & {
  readonly origin?: ParsedWorkflowFileRunDetail['origin'];
};

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
  return runDetailSchema.parse(await callBureau('bureau.workflows.runs.get', { runId }, options));
}

/** The newest `limit` instances of one workflow file. */
export async function listWorkflowFileRuns(
  id: string,
  limit: number,
  options?: Options,
): Promise<readonly WorkflowFileRun[]> {
  const page = z
    .object({ runs: z.array(runSummarySchema) })
    .parse(await callBureau('bureau.workflows.runs.list', { workflow: id, limit }, options));
  return page.runs;
}

/** Replaces the workflow's file, if it still hashes to `expectedHash`. */
export async function updateWorkflowFile(
  id: string,
  expectedHash: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.workflows.update', { id, expectedHash, definition }, options),
  );
}

const impactChangeSchema = z.object({
  kind: z.string(),
  /** The step's position, counted from 1, for a change to one step. */
  step: z.number().optional(),
  /** What it was and what it becomes, for a change that names both (a step's signal, its agent). */
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  breaking: z.boolean(),
});

const impactSchema = z.object({
  version: z.string().nullable(),
  previousVersion: z.string().nullable(),
  changes: z.array(impactChangeSchema),
  compatibility: z.enum(['compatible', 'breaking']).nullable(),
  inFlight: z.number().nullable(),
});

/**
 * What saving a definition would do, as `bureau.workflows.impact` answers it: the `version` the
 * save makes (`null` when it changes nothing that makes one), the `previousVersion` it replaces,
 * each change with whether it is `breaking`, the verdict, and how many runs are `inFlight` (`null`
 * when the caller may not count them).
 */
export type WorkflowImpact = z.infer<typeof impactSchema>;

/** One change {@link WorkflowImpact} lists. */
export type WorkflowImpactChange = WorkflowImpact['changes'][number];

/** What saving `definition` as the workflow `id` would do. It writes nothing. */
export async function getWorkflowImpact(
  id: string,
  definition: WorkflowDefinitionInput,
  options?: Options,
): Promise<WorkflowImpact> {
  return impactSchema.parse(
    await callBureau('bureau.workflows.impact', { id, definition }, options),
  );
}

/** Sets `paused: true` in the workflow's file, if it still hashes to `expectedHash`. */
export async function pauseWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.workflows.pause', { id, expectedHash }, options),
  );
}

/** Sets `paused: false` in the workflow's file, if it still hashes to `expectedHash`. */
export async function resumeWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.workflows.resume', { id, expectedHash }, options),
  );
}

/** Deletes the workflow's file, if it still hashes to `expectedHash`. */
export async function deleteWorkflowFile(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<WorkflowWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.workflows.delete', { id, expectedHash }, options),
  );
}

/**
 * Delivers a signal to the running instances waiting for it, and starts the workflows whose trigger
 * it is. An absent payload is sent as none.
 */
export async function signalWorkflows(
  input: { readonly name: string; readonly payload?: unknown },
  options?: Options,
): Promise<SignalResult> {
  const params = input.payload === undefined ? { name: input.name } : input;
  return signalResultSchema.parse(await callBureau('bureau.workflows.signal', params, options));
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
