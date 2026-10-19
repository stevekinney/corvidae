/**
 * What a Bureau does with a directory of workflow files (COR-1527): load them, register them with
 * the engine as workflow types, keep the engine and the schedules matching the files, and answer
 * for the revisions and runs. It is the object behind `Bureau.workflows`, and the operations of
 * `bureau.workflows.*` are thin wrappers over it, so COR-1528 and COR-1529 call the same methods
 * in-process.
 *
 * ## Startup
 *
 * {@link WorkflowRuntime.start} runs before the engine recovers, in this order: scan the
 * directory; ask the engine which `workflowVersion`s still have an instance in flight (it can
 * answer before anything is registered or recovered); register every ready file's document as
 * `active` and, for each in-flight version that is no longer the file's, the stored snapshot as
 * `retained`; put every schedule back to match the files. Snapshots are written before the
 * registration they back.
 *
 * ## Afterwards
 *
 * Every change to the directory runs the same registration and schedule steps, one at a time. A
 * registered revision stays registered in this process, so an instance on an older revision keeps
 * running when the file changes; after a restart it is the snapshot that brings it back.
 *
 * @module workflow-runtime
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type DocumentWorkflowHost,
  type Engine,
  type RegisteredWorkflowDocument,
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  type WorkflowDocument,
  type WorkflowState,
  type WorkflowStatus,
} from '@lostgradient/weft';

import type { AgentFileOperations } from './agent-file-operations';
import { ownerOrLocal } from './owner-of-record';
import type { DirectoryChange } from './watched-directory';
import type { WorkflowFileDefinition } from './workflow-file';
import {
  createWorkflowFileCatalog,
  type ReadyWorkflowFile,
  type WorkflowFileCatalog,
  type WorkflowFileWriteResult,
  type WorkflowListing,
} from './workflow-file-catalog';
import { registerBureauWorkflowDocuments, type ScheduleOverlapPolicy } from './workflow-host';
import {
  type DesiredWorkflowSchedule,
  parseWorkflowScheduleId,
  reconcileWorkflowSchedules,
} from './workflow-schedule';
import {
  createWorkflowSnapshotStore,
  type WorkflowRevision,
  type WorkflowSnapshot,
  type WorkflowSnapshotStore,
} from './workflow-snapshot-store';

/** The statuses of an instance that has not finished: the runs whose revision must stay loadable. */
const IN_FLIGHT_STATUSES: readonly WorkflowStatus[] = ['pending', 'running', 'suspended'];

/** The most runs of one workflow `runs.list` reads, so a long history cannot make one call unbounded. */
const RUNS_READ_LIMIT_PER_WORKFLOW = 1000;

/** One workflow in {@link BureauWorkflows.get}. */
export interface WorkflowDetail extends WorkflowListing {
  /** The file's text, for an editor that writes it back with `expectedHash`. */
  readonly text?: string;
  /** The workflow's native schedule, when it has a live one. */
  readonly schedule: {
    readonly id: string;
    readonly status: 'active' | 'paused';
    readonly nextFireAt: string | null;
  } | null;
}

/** One instance of a workflow. */
export interface WorkflowRunSummary {
  readonly id: string;
  readonly workflow: string;
  readonly workflowVersion: string;
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One instance with what started it and how it ended. */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  /** What started the instance: a schedule's trigger. */
  readonly trigger: unknown;
  readonly result?: unknown;
  /** Why the instance failed, for a run that did, including a failed agent step. */
  readonly error?: string;
}

export interface WorkflowRunFilter {
  readonly workflow?: string | undefined;
  readonly status?: WorkflowStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** The workflow files of a Bureau, as `Bureau.workflows`. */
export interface BureauWorkflows {
  /** The deployment's owner of record, which every workflow file belongs to. */
  readonly owner: string;
  readonly list: () => readonly WorkflowListing[];
  readonly get: (id: string) => Promise<WorkflowDetail | undefined>;
  readonly create: (
    id: string,
    definition: WorkflowFileDefinition,
  ) => Promise<WorkflowFileWriteResult>;
  readonly update: (
    id: string,
    definition: WorkflowFileDefinition,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  readonly pause: (
    id: string,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  readonly resume: (
    id: string,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  readonly delete: (
    id: string,
    options: { readonly expectedHash: string },
  ) => Promise<WorkflowFileWriteResult>;
  /** The revisions of `id` that have run, newest first; `undefined` when there is no such workflow. */
  readonly revisions: (id: string) => Promise<readonly WorkflowRevision[] | undefined>;
  readonly listRuns: (filter: WorkflowRunFilter) => Promise<{
    readonly runs: readonly WorkflowRunSummary[];
    readonly nextOffset: number | null;
  }>;
  readonly getRun: (runId: string) => Promise<WorkflowRunDetail | undefined>;
  /** Rescan the directory; resolves once the engine and the schedules match it. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed a workflow. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DirectoryChange) => void) => () => void;
  /**
   * Throws `BureauError` `NOT_FOUND` unless `id` is a ready, unpaused workflow: the check a path
   * that starts a workflow by identifier (COR-1528's signal) makes, so a paused or deleted
   * workflow is refused as if it did not exist.
   */
  readonly assertStartable: (id: string) => void;
}

/** What {@link WorkflowRuntime.start} registered as `retained`. */
export interface WorkflowStartReport {
  readonly retained: readonly { readonly id: string; readonly workflowVersion: string }[];
}

/** What {@link createWorkflowRuntime} builds. */
export interface WorkflowRuntime {
  readonly workflows: BureauWorkflows;
  /**
   * Register everything and reconcile the schedules. Call once, before the engine recovers.
   * Resolves what it registered beyond the files' own documents: the older revisions that still
   * have an instance in flight.
   */
  readonly start: () => Promise<WorkflowStartReport>;
  /** Whether `type` names a workflow Bureau registered from a file, now or earlier. */
  readonly isWorkflowType: (type: string) => Promise<boolean>;
  /** Whether Bureau registered `type` from a file in this process. Synchronous, for the services resolver. */
  readonly isRegisteredType: (type: string) => boolean;
  /** Whether `scheduleId` is a Bureau workflow schedule that exists. */
  readonly scheduleExists: (scheduleId: string) => Promise<boolean>;
  /** Delete the stored revisions nothing holds and nothing used since `cutoff` (epoch milliseconds). */
  readonly pruneSnapshots: (cutoff: number) => Promise<number>;
  /** Stop watching and wait for work in flight. */
  readonly close: () => Promise<void>;
}

export interface WorkflowRuntimeOptions {
  readonly directory: string;
  readonly engine: Engine;
  readonly host: DocumentWorkflowHost;
  /** Where snapshots live; durable in a Bureau, since this needs the durable engine. */
  readonly snapshotStore: WorkflowSnapshotStore;
  readonly runtime: RuntimeServices;
  readonly diagnose: (message: string, cause: unknown) => void;
  readonly createError: (message: string, code: 'NOT_FOUND') => Error;
  /** Registers background work with the Bureau, so a test can wait for it to settle. */
  readonly track?: ((promise: Promise<unknown>, label: string) => void) | undefined;
  readonly operations?: AgentFileOperations | undefined;
  readonly watch?: boolean | undefined;
  readonly openWatcher?: Parameters<typeof createWorkflowFileCatalog>[0]['openWatcher'];
}

function scheduleOf(file: ReadyWorkflowFile): DesiredWorkflowSchedule | undefined {
  const trigger = file.document.trigger;
  if (trigger.kind !== 'schedule') return undefined;
  return {
    spec: typeof trigger['spec'] === 'string' ? trigger['spec'] : '',
    overlap: (trigger['overlap'] ?? 'skip') as ScheduleOverlapPolicy,
    paused: file.paused,
  };
}

export { createWorkflowSnapshotStore };

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const { engine, host, snapshotStore: snapshots } = options;
  const owner = ownerOrLocal(undefined);
  /** The workflow types Bureau registered from a file in this process. */
  const registeredTypes = new Set<string>();
  /** Stamps of a revision's runs that have not finished being written. */
  const pendingStamps = new Set<Promise<unknown>>();
  let closed = false;
  let started = false;

  const catalog: WorkflowFileCatalog = createWorkflowFileCatalog({
    directory: options.directory,
    host,
    // A name the engine already has that Bureau did not register itself is a code workflow.
    isCodeWorkflow: (id) =>
      engine.getWorkflowDefinition(id) !== undefined && !registeredTypes.has(id),
    runtime: options.runtime,
    diagnose: options.diagnose,
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.openWatcher === undefined ? {} : { openWatcher: options.openWatcher }),
  });

  const track = (promise: Promise<unknown>, label: string): void => {
    options.track?.(promise, label);
  };

  /** One step at a time: registration, snapshots, and schedules never interleave. */
  let applyTail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = applyTail.then(work, work);
    applyTail = result.catch(() => undefined);
    return result;
  }

  function readyFiles(): ReadyWorkflowFile[] {
    return catalog.list().flatMap((listing) => {
      const file = catalog.find(listing.id);
      return file === undefined ? [] : [file];
    });
  }

  function desiredSchedules(): Map<string, DesiredWorkflowSchedule> {
    const desired = new Map<string, DesiredWorkflowSchedule>();
    for (const file of readyFiles()) {
      const schedule = scheduleOf(file);
      if (schedule !== undefined) desired.set(file.id, schedule);
    }
    return desired;
  }

  /** The distinct `workflowVersion`s of the instances of `type` that have not finished, with their start times. */
  async function inFlightVersions(type: string): Promise<Map<string, number>> {
    const earliest = new Map<string, number>();
    for (let offset = 0; ;) {
      const page = await engine.list({ type, status: [...IN_FLIGHT_STATUSES], limit: 100, offset });
      for (const summary of page.items) {
        const known = earliest.get(summary.version);
        if (known === undefined || summary.createdAt < known) {
          earliest.set(summary.version, summary.createdAt);
        }
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return earliest;
  }

  /** Register the files' documents, and the older revisions that still have an instance in flight. */
  async function register(retained: readonly WorkflowDocument[]): Promise<void> {
    const files = readyFiles();
    // The snapshot first: a revision never reaches the engine without one behind it.
    for (const file of files) await snapshots.ensure(file.id, file.document);
    const registered: readonly RegisteredWorkflowDocument[] = await registerBureauWorkflowDocuments(
      engine,
      host,
      { active: files.map((file) => file.document), retained },
    );
    for (const entry of registered) registeredTypes.add(entry.name);
  }

  /** The stored documents of the in-flight revisions that are not any file's current one. */
  async function retainedDocuments(): Promise<
    { id: string; version: string; document: WorkflowDocument }[]
  > {
    const identifiers = new Set([
      ...catalog.list().map((listing) => listing.id),
      ...(await snapshots.identifiers()),
    ]);
    const retained: { id: string; version: string; document: WorkflowDocument }[] = [];
    for (const id of identifiers) {
      const current = catalog.find(id)?.version;
      for (const [version, startedAt] of await inFlightVersions(id)) {
        // An instance that started before a crash can have lost its history stamp: restore it.
        await snapshots.stampRun(id, version, new Date(startedAt).toISOString());
        if (version === current) continue;
        let snapshot: WorkflowSnapshot | undefined;
        try {
          snapshot = await snapshots.load(id, version);
        } catch (error) {
          options.diagnose(
            `The stored revision ${version} of workflow "${id}" cannot be used, so its instances cannot resume.`,
            error,
          );
          continue;
        }
        if (snapshot === undefined) {
          options.diagnose(
            `Workflow "${id}" has an instance in flight on revision ${version}, which is not stored, so it cannot resume.`,
            undefined,
          );
          continue;
        }
        try {
          retained.push({
            id,
            version,
            document: validateWorkflowDocument(snapshot.document, host),
          });
        } catch (error) {
          if (!(error instanceof WorkflowDocumentValidationError)) throw error;
          options.diagnose(
            `The stored revision ${version} of workflow "${id}" no longer validates, so its instances cannot resume.`,
            error,
          );
        }
      }
    }
    return retained;
  }

  async function applyChange(): Promise<void> {
    if (closed) return;
    try {
      await register([]);
      await reconcileWorkflowSchedules(engine, desiredSchedules());
    } catch (error) {
      options.diagnose('Could not bring the engine in line with the workflow files.', error);
    }
  }

  /** Wait for whatever the last change started. */
  async function settled(): Promise<void> {
    await applyTail;
    await Promise.allSettled(pendingStamps);
  }

  let stopListening: (() => void) | undefined;
  const onStarted = (event: Event): void => {
    const { workflowId, workflowType } = event as Event & {
      workflowId: string;
      workflowType: string;
    };
    if (!registeredTypes.has(workflowType)) return;
    const stamp = (async () => {
      const state = await engine.get(workflowId);
      if (state === null || state === undefined) return;
      await snapshots.stampRun(
        workflowType,
        state.versionTuple.workflowVersion,
        new Date(state.createdAt).toISOString(),
      );
    })().catch((error: unknown) => {
      options.diagnose(`Could not record that workflow "${workflowType}" ran.`, error);
    });
    pendingStamps.add(stamp);
    void stamp.finally(() => pendingStamps.delete(stamp));
    track(stamp, 'workflow-run-stamp');
  };

  async function start(): Promise<WorkflowStartReport> {
    if (started) return { retained: [] };
    started = true;
    // Listening begins before the first scan: a change that lands while startup is still talking to
    // the engine would otherwise be consumed by a scan nobody was told about, and the engine would
    // not hear of it until some other file changed. The scan the startup itself triggers queues one
    // redundant `applyChange` behind it; registering the same documents again changes nothing.
    engine.addEventListener('workflow:started', onStarted);
    const unsubscribe = catalog.onChange(() => {
      track(exclusive(applyChange), 'workflow-files-apply');
    });
    stopListening = () => {
      engine.removeEventListener('workflow:started', onStarted);
      unsubscribe();
    };
    return exclusive(async () => {
      await catalog.refresh();
      const retained = await retainedDocuments();
      await register(retained.map((entry) => entry.document));
      await reconcileWorkflowSchedules(engine, desiredSchedules());
      return {
        retained: retained.map((entry) => ({ id: entry.id, workflowVersion: entry.version })),
      };
    });
  }

  async function liveSchedule(id: string): Promise<WorkflowDetail['schedule']> {
    for (let offset = 0; ;) {
      const page = await engine.listSchedules({ status: ['active', 'paused'], limit: 100, offset });
      for (const summary of page.items) {
        if (parseWorkflowScheduleId(summary.id)?.identifier !== id) continue;
        return {
          id: summary.id,
          status: summary.status as 'active' | 'paused',
          nextFireAt:
            summary.nextFireAt === null ? null : new Date(summary.nextFireAt).toISOString(),
        };
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return null;
    }
  }

  function summarize(state: {
    id: string;
    type: string;
    status: WorkflowStatus;
    version: string;
    createdAt: number;
    updatedAt: number;
  }): WorkflowRunSummary {
    return {
      id: state.id,
      workflow: state.type,
      workflowVersion: state.version,
      status: state.status,
      createdAt: new Date(state.createdAt).toISOString(),
      updatedAt: new Date(state.updatedAt).toISOString(),
    };
  }

  /** Stamp the first and last start of every revision of `type` that has an instance in the engine. */
  async function syncRunHistory(type: string): Promise<void> {
    const bounds = new Map<string, { first: number; last: number }>();
    for (let offset = 0; offset < RUNS_READ_LIMIT_PER_WORKFLOW;) {
      const page = await engine.list({ type, limit: 100, offset });
      for (const summary of page.items) {
        const known = bounds.get(summary.version);
        bounds.set(summary.version, {
          first: Math.min(known?.first ?? summary.createdAt, summary.createdAt),
          last: Math.max(known?.last ?? summary.createdAt, summary.createdAt),
        });
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    for (const [version, { first, last }] of bounds) {
      await snapshots.stampRun(type, version, new Date(first).toISOString());
      if (last !== first) await snapshots.stampRun(type, version, new Date(last).toISOString());
    }
  }

  async function knownTypes(): Promise<string[]> {
    return [
      ...new Set([
        ...catalog.list().map((listing) => listing.id),
        ...(await snapshots.identifiers()),
      ]),
    ].toSorted();
  }

  async function isWorkflowType(type: string): Promise<boolean> {
    if (registeredTypes.has(type)) return true;
    const stored = await snapshots.identifiers();
    return stored.includes(type);
  }

  async function write<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    await settled();
    return result;
  }

  const workflows: BureauWorkflows = {
    owner,
    list: () => catalog.list(),

    async get(id) {
      const listing = catalog.list().find((entry) => entry.id === id);
      if (listing === undefined) return undefined;
      const read = await catalog.read(id).catch(() => undefined);
      return {
        ...listing,
        ...(read === undefined ? {} : { text: read.text }),
        schedule: await liveSchedule(id),
      };
    },

    create: (id, definition) => write(() => catalog.create(id, definition)),
    update: (id, definition, update) => write(() => catalog.update(id, definition, update)),
    pause: (id, guard) => write(() => catalog.setPaused(id, true, guard)),
    resume: (id, guard) => write(() => catalog.setPaused(id, false, guard)),
    delete: (id, guard) => write(() => catalog.delete(id, guard)),

    async revisions(id) {
      await Promise.allSettled(pendingStamps);
      // The engine's own record of when each revision's instances began is the source of truth: a
      // start event can arrive after the call that made the instance, or never (a crash).
      await syncRunHistory(id);
      const revisions = await snapshots.revisions(id);
      if (revisions.length > 0) return revisions;
      if (catalog.list().some((entry) => entry.id === id)) return [];
      const stored = await snapshots.snapshotsOf(id);
      return stored.length > 0 ? [] : undefined;
    },

    async listRuns(filter) {
      const types =
        filter.workflow === undefined
          ? await knownTypes()
          : (await isWorkflowType(filter.workflow))
            ? [filter.workflow]
            : [];
      const found: WorkflowRunSummary[] = [];
      for (const type of types) {
        for (let offset = 0; offset < RUNS_READ_LIMIT_PER_WORKFLOW;) {
          const page = await engine.list({
            type,
            ...(filter.status === undefined ? {} : { status: filter.status }),
            limit: 100,
            offset,
          });
          found.push(...page.items.map(summarize));
          offset += page.items.length;
          if (page.items.length === 0 || offset >= page.total) break;
        }
      }
      const ordered = found.toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      );
      const runs = ordered.slice(filter.offset, filter.offset + filter.limit);
      return {
        runs,
        nextOffset:
          ordered.length > filter.offset + filter.limit ? filter.offset + filter.limit : null,
      };
    },

    async getRun(runId) {
      const state: WorkflowState | null | undefined = await engine.get(runId);
      if (state === null || state === undefined || !(await isWorkflowType(state.type))) {
        return undefined;
      }
      return {
        ...summarize({
          id: state.id,
          type: state.type,
          status: state.status,
          version: state.versionTuple.workflowVersion,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        }),
        trigger: state.input,
        ...(state.result === undefined ? {} : { result: state.result }),
        ...(state.error === undefined ? {} : { error: state.error }),
      };
    },

    async refresh() {
      await catalog.refresh();
      await settled();
    },

    onChange: (listener) => catalog.onChange(listener),

    assertStartable(id) {
      const file = catalog.find(id);
      if (file === undefined || file.paused) {
        throw options.createError(`Workflow "${id}" does not exist`, 'NOT_FOUND');
      }
    },
  };

  return {
    workflows,
    start,

    isWorkflowType,
    isRegisteredType: (type) => registeredTypes.has(type),

    async scheduleExists(scheduleId) {
      if (parseWorkflowScheduleId(scheduleId) === undefined) return false;
      return (await engine.getSchedule(scheduleId)) !== null;
    },

    async pruneSnapshots(cutoff) {
      const inFlight = new Map<string, Map<string, number>>();
      const versionsOf = async (type: string) => {
        const cached = inFlight.get(type);
        if (cached !== undefined) return cached;
        const found = await inFlightVersions(type);
        inFlight.set(type, found);
        return found;
      };
      return exclusive(() =>
        snapshots.pruneUnheld({
          cutoff,
          isHeld: async (snapshot) => {
            if (catalog.find(snapshot.id)?.version === snapshot.workflowVersion) return true;
            const pinned = await versionsOf(snapshot.id);
            return pinned.has(snapshot.workflowVersion);
          },
          lastActivityAt: async (snapshot) => {
            let latest: number | undefined;
            for (let offset = 0; offset < RUNS_READ_LIMIT_PER_WORKFLOW;) {
              const page = await engine.list({ type: snapshot.id, limit: 100, offset });
              for (const summary of page.items) {
                if (summary.version !== snapshot.workflowVersion) continue;
                latest = Math.max(latest ?? 0, summary.updatedAt);
              }
              offset += page.items.length;
              if (page.items.length === 0 || offset >= page.total) break;
            }
            return latest;
          },
        }),
      );
    },

    async close() {
      closed = true;
      stopListening?.();
      await catalog.close();
      await settled();
    },
  };
}
