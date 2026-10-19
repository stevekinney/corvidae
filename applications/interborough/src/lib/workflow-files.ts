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

export type WorkflowProblem = z.infer<typeof problemSchema>;

const listingSchema = z.object({
  id: z.string(),
  state: z.enum(['ready', 'invalid']),
  owner: z.string(),
  hash: z.string().nullable(),
  agent: z.string().nullable(),
  paused: z.boolean(),
  version: z.string().nullable(),
  problem: problemSchema.nullable(),
});

/** One entry of `bureau.workflows.list`: a file, with whether the Bureau could use it. */
export type WorkflowFileListing = z.infer<typeof listingSchema>;

const detailSchema = listingSchema.extend({
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
      }),
    }),
  ),
});

/** A version of the workflow's document that has run. */
export type WorkflowRevision = z.infer<typeof revisionsSchema>['revisions'][number];

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

/** What a write answers: the workflow's identifier and the hash of the file now on disk. */
export type WorkflowWriteResult = z.infer<typeof writeResultSchema>;

const signalResultSchema = z.object({
  started: z.array(z.string()),
  delivered: z.array(z.string()),
});

/** The instances a signal started, and the ones it was delivered to. */
export type SignalResult = z.infer<typeof signalResultSchema>;

/** The largest page `bureau.workflows.list` answers. */
const LISTING_PAGE_SIZE = 100;

/** Every workflow file, `ready` and `invalid` alike. It follows the pages to the end. */
export async function listWorkflowFiles(
  options?: Options,
): Promise<readonly WorkflowFileListing[]> {
  const listings: WorkflowFileListing[] = [];
  let offset: number | null = 0;
  const pageSchema = z.object({
    workflows: z.array(listingSchema),
    nextOffset: z.number().nullable(),
  });
  while (offset !== null) {
    const page: z.infer<typeof pageSchema> = pageSchema.parse(
      await callBureau('bureau.workflows.list', { limit: LISTING_PAGE_SIZE, offset }, options),
    );
    listings.push(...page.workflows);
    offset = page.nextOffset;
  }
  return listings;
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

/**
 * What an update sends: the document without its `name`, which the Bureau sets to the identifier.
 * The update schema rejects a key it does not know, so `name` is stripped and every other key is
 * kept as it was written, so the Bureau can refuse one that is wrong.
 */
export type WorkflowDefinitionInput = Readonly<Record<string, unknown>>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const documentSchema = z.looseObject({
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
