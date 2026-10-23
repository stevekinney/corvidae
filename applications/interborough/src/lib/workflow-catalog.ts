/**
 * The Workflows area's data: which workflow types exist, and which service each belongs to.
 *
 * Two services answer. The engine's catalog (`weft.workflows.definitions.*`) lists every type it
 * can run, those code registered and those it loaded from a source. The Bureau (`bureau.workflows.*`)
 * lists the workflow files, JSON documents that agents and people write; the engine loads each ready
 * one as a source whose name is the file's identifier. The two are joined on that name.
 *
 * - A type the engine holds as a source with no Bureau file is left out. It is a file that was
 *   deleted and that the engine has not yet forgotten, so leaving it out makes the list read the
 *   same before and after a restart.
 * - A Bureau file is listed whether or not the engine has a definition for it: an invalid file never
 *   has one, and a ready one has none until the engine applies it.
 * - A type with no file is code-defined. `origin` records how the engine loaded a type, never who
 *   wrote it, so a type is agent-authored exactly when the Bureau holds a file for it.
 */
import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
import type { FailureCategory, HttpClient, ScheduleStatus } from '@lostgradient/weft';
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';
import { classifyFault } from './faults.ts';
import {
  getWorkflowFile,
  listWorkflowFiles,
  type WorkflowDocument,
  type WorkflowFileDetail,
  type WorkflowFileListing,
  type WorkflowProblem,
  type WorkflowRunCounts,
} from './workflow-files.ts';

type DefinitionList = Awaited<
  ReturnType<HttpClient['operations']['weft.workflows.definitions.list']>
>;
type DefinitionGet = Awaited<
  ReturnType<HttpClient['operations']['weft.workflows.definitions.get']>
>;

/** One workflow type as `weft.workflows.definitions.list` summarises it. */
export type DefinitionSummary = DefinitionList['definitions'][number];

/** One workflow type with the full contract of its active revision. */
export type DefinitionDetail = DefinitionGet;

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** The largest page `weft.workflows.definitions.list` answers. */
const DEFINITION_PAGE_SIZE = 1000;

/** Every workflow type the engine can run, following the pages to the end. */
export async function listDefinitions(client: HttpClient): Promise<readonly DefinitionSummary[]> {
  const definitions: DefinitionSummary[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page: DefinitionList = await client.operations['weft.workflows.definitions.list']({
      limit: DEFINITION_PAGE_SIZE,
      offset,
    });
    definitions.push(...page.definitions);
    offset = page.nextOffset;
  }
  return definitions;
}

/** Runs `read`, and answers `undefined` for a `NotFound` fault, which is an answer here. Anything else is thrown. */
export async function orNotFound<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (classifyFault(error)?.kind === 'not-found') return undefined;
    throw error;
  }
}

/**
 * One workflow type with its contract, or `undefined` when the engine has no such type. A name the
 * engine refuses before it looks (one with a dot in it) names no type either, as the Bureau
 * answers for it: it is missing, not a failure.
 */
export async function getDefinition(
  client: HttpClient,
  name: string,
): Promise<DefinitionDetail | undefined> {
  try {
    return await client.operations['weft.workflows.definitions.get']({ name });
  } catch (error) {
    const kind = classifyFault(error)?.kind;
    if (kind === 'not-found' || kind === 'invalid') return undefined;
    throw error;
  }
}

/** How long a load of the list stays fresh, so the view frame's probe and the page share one. */
export const CATALOG_STALE_TIME_MS = 5_000;

/** One row of the list: a workflow type, with the parts of each service that know it. */
export type CatalogRow = {
  readonly name: string;
  /** `agent-authored` exactly when the Bureau holds a file for the name. */
  readonly kind: 'code' | 'agent-authored';
  /** The agent that wrote the file, when it names one. */
  readonly agent: string | null;
  /** What the workflow is for: the file's own words, else the engine's description of the type. */
  readonly description: string | null;
  /** Whether the Bureau itself registers the type to run agents, goals, and its heartbeat. */
  readonly engine: boolean;
  /** How busy the workflow is, when the Bureau counts it (a file that loaded). A code type's are read apart. */
  readonly runs: WorkflowRunCounts | null;
  /** The file's trigger as written, for a file that loaded. */
  readonly trigger: Readonly<Record<string, unknown>> | null;
  /** The Bureau's file, for an agent-authored type. */
  readonly file: WorkflowFileListing | null;
  /** Why the Bureau cannot use the file, when it cannot. */
  readonly problem: WorkflowProblem | null;
  /** The category the engine gave a source that failed to load. */
  readonly failure: FailureCategory | null;
};

/** Joins the engine's definitions with the Bureau's files on the name. See the module's rules. */
export function joinCatalog(
  definitions: readonly DefinitionSummary[],
  files: readonly WorkflowFileListing[],
): CatalogRow[] {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const fileIds = new Set(files.map((file) => file.id));
  const rows: CatalogRow[] = [];

  for (const file of files) {
    const definition = byName.get(file.id);
    rows.push({
      name: file.id,
      kind: 'agent-authored',
      agent: file.agent,
      description: file.description ?? definition?.description ?? null,
      engine: false,
      runs: file.runs,
      trigger: file.trigger,
      file,
      problem: file.problem,
      failure:
        definition?.state === 'failed' && definition.origin === 'source'
          ? definition.lastFailureCategory
          : null,
    });
  }
  for (const definition of definitions) {
    if (fileIds.has(definition.name)) continue;
    // A source with no file is a deleted file the engine has not yet forgotten.
    if (definition.origin === 'source') continue;
    rows.push({
      name: definition.name,
      kind: 'code',
      agent: null,
      description: definition.description,
      engine: isEngineType(definition.name),
      runs: null,
      trigger: null,
      file: null,
      problem: null,
      failure: null,
    });
  }
  return rows.toSorted((first, second) => compareNames(first.name, second.name));
}

/**
 * Whether a type is one the Bureau registers itself to run agents, goals, and its heartbeat
 * (`RUN_ENGINE_WORKFLOW_TYPES`). A person never starts one, so the catalog keeps them apart.
 */
export function isEngineType(name: string): boolean {
  return (RUN_ENGINE_WORKFLOW_TYPES as readonly string[]).includes(name);
}

/** The order the engine lists types in: by code point, not by locale. */
function compareNames(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

/** The list: every definition and every file, joined. */
export async function loadCatalog(client: HttpClient, options?: Options): Promise<CatalogRow[]> {
  const [definitions, files] = await Promise.all([
    listDefinitions(client),
    listWorkflowFiles({ ...options, includeRuns: true }),
  ]);
  return joinCatalog(definitions, files);
}

/** What one workflow type is, with what each service says of it. */
export type WorkflowResolution =
  | { readonly kind: 'code'; readonly definition: DefinitionDetail }
  | {
      readonly kind: 'agent-authored';
      readonly file: WorkflowFileDetail;
      /** The engine's definition of the file's document: absent for an invalid file, or one not yet applied. */
      readonly definition: DefinitionDetail | undefined;
    };

/**
 * Which service a type belongs to, or `undefined` when neither answers for it.
 *
 * The Bureau having the file makes the type agent-authored. With no file, the engine decides: a
 * code-defined type exists, and one it holds only as a source is a deleted file that it has not yet
 * forgotten, which does not exist. A failure of either service is thrown, and is never read as a
 * missing type.
 */
export async function resolveWorkflow(
  client: HttpClient,
  type: string,
  options?: Options,
): Promise<WorkflowResolution | undefined> {
  const [file, definition] = await Promise.all([
    orNotFound(getWorkflowFile(type, options)),
    getDefinition(client, type),
  ]);
  if (file === undefined) {
    if (definition === undefined || definition.origin === 'source') return undefined;
    return { kind: 'code', definition };
  }
  // An invalid file has no definition section, even if the engine still holds an earlier one.
  const loaded = file.state === 'ready' && definition?.origin === 'source' ? definition : undefined;
  return { kind: 'agent-authored', file, definition: loaded };
}

/** The schedules that start a type: the active and the paused, never a cancelled generation. */
export function startingSchedules<T extends { readonly status: ScheduleStatus }>(
  schedules: readonly T[],
): T[] {
  return schedules.filter((schedule) => schedule.status !== 'cancelled');
}

/** What a file can be asked to do. */
export type FileActions = {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly delete: boolean;
  readonly edit: boolean;
  readonly signal: boolean;
};

/**
 * The actions a file offers. A write names the file's hash, so a file with none, which the Bureau
 * could not read, offers none. A file the Bureau cannot use cannot be paused, resumed, or sent a
 * signal, but it can be fixed or removed.
 */
export function availableActions(file: Pick<WorkflowFileListing, 'state' | 'hash'>): FileActions {
  const writable = file.hash !== null;
  const ready = file.state === 'ready';
  return {
    pause: ready && writable,
    resume: ready && writable,
    delete: writable,
    edit: writable,
    signal: ready,
  };
}

/** The signal names a document's steps wait for, once each, in order. */
export function awaitedSignals(document: WorkflowDocument | undefined): string[] {
  const names: string[] = [];
  for (const step of document?.steps ?? []) {
    const signal = step['signal'];
    if (step.kind === 'await-signal' && typeof signal === 'string' && !names.includes(signal)) {
      names.push(signal);
    }
  }
  return names;
}

/** The signal name a form starts with: the trigger's, when the trigger is a signal, else the first one a step awaits. */
export function defaultSignalName(document: WorkflowDocument | undefined): string {
  if (document === undefined) return '';
  const name = document.trigger['name'];
  if (document.trigger.kind === 'signal' && typeof name === 'string') return name;
  return awaitedSignals(document)[0] ?? '';
}

const instancePageSchema = z.object({
  total: z.number(),
  items: z.array(z.object({ createdAt: z.number() })),
});

/** How far back a type's recent instances are counted, as the Bureau counts a file's. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The statuses of an instance that has not finished. */
/** How far back a quiet type's newest instance is looked for before its whole history is read. */
const QUIET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES = ['pending', 'running', 'suspended'] as const;

/** What the engine says of a code-defined type's activity: its instance counts and its schedules. */
export type CodeActivity = {
  /** `null` when the engine would not count. A count that could not be read is never shown as zero. */
  readonly runs: WorkflowRunCounts | null;
  /** The schedules that start the type, `null` when the engine would not list them. */
  readonly schedules:
    readonly { readonly cronExpression?: string; readonly intervalMs?: number }[] | null;
};

/**
 * The instance counts and the schedules of each named code-defined type, from the engine's own
 * totals (`weft.workflows.list` with `limit: 1`, which still answers the total) and its schedule
 * list. A type whose reads fail has `null` for what failed: the page says nothing of it.
 */
export async function loadCodeActivity(
  client: HttpClient,
  names: readonly string[],
  now: number = Date.now(),
): Promise<ReadonlyMap<string, CodeActivity>> {
  const list = async (filter: Record<string, unknown>) =>
    instancePageSchema.parse(
      await client.operations['weft.workflows.list']({ ...filter, limit: 1 }),
    );
  async function runsOf(type: string): Promise<WorkflowRunCounts | null> {
    try {
      // The engine narrows by its type, status, and created-at indexes before it loads any state,
      // so each read loads only the instances it counts.
      const [active, recent] = await Promise.all([
        list({ type, status: ACTIVE_STATUSES }),
        list({ type, createdAt: { gte: now - RECENT_WINDOW_MS } }),
      ]);
      // The engine lists newest first, so the one item of a page is the newest in its window. A type
      // that ran today has its newest already; a quiet one looks back further, and reads its whole
      // history only as the last resort.
      let last = recent.items[0];
      for (const windowMs of [QUIET_WINDOW_MS, undefined]) {
        if (last !== undefined) break;
        const page = await list({
          type,
          ...(windowMs === undefined ? {} : { createdAt: { gte: now - windowMs } }),
        });
        last = page.items[0];
      }
      return {
        active: active.total,
        last24Hours: recent.total,
        lastRunAt: last === undefined ? null : new Date(last.createdAt).toISOString(),
      };
    } catch {
      return null;
    }
  }
  async function schedulesOf(type: string): Promise<CodeActivity['schedules']> {
    try {
      const page = await client.listSchedules({ workflowType: type });
      return startingSchedules(page.items);
    } catch {
      return null;
    }
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const [runs, schedules] = await Promise.all([runsOf(name), schedulesOf(name)]);
      return [name, { runs, schedules }] as const;
    }),
  );
  return new Map(entries);
}
