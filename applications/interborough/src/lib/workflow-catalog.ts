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
import type { FailureCategory, HttpClient, ScheduleStatus } from '@lostgradient/weft';

import type { Fetcher } from './bureau-client.ts';
import { classifyFault } from './faults.ts';
import {
  getWorkflowFile,
  listWorkflowFiles,
  type WorkflowDocument,
  type WorkflowFileDetail,
  type WorkflowFileListing,
  type WorkflowProblem,
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

/** One workflow type with its contract, or `undefined` when the engine has no such type. */
export function getDefinition(
  client: HttpClient,
  name: string,
): Promise<DefinitionDetail | undefined> {
  return orNotFound(client.operations['weft.workflows.definitions.get']({ name }));
}

/** One row of the list: a workflow type, with the parts of each service that know it. */
export type CatalogRow = {
  readonly name: string;
  /** `agent-authored` exactly when the Bureau holds a file for the name. */
  readonly kind: 'code' | 'agent-authored';
  /** The agent that wrote the file, when it names one. */
  readonly agent: string | null;
  readonly description: string | null;
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
      description: definition?.description ?? null,
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
      file: null,
      problem: null,
      failure: null,
    });
  }
  return rows.toSorted((first, second) => compareNames(first.name, second.name));
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
    listWorkflowFiles(options),
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
