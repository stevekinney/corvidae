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
  encode,
  type Engine,
  type RegisteredWorkflowDocument,
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  type WorkflowDocument,
  type WorkflowState,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentFileOperations } from './agent-file-operations';
import { auditTrailWorkflowOwnerId } from './audit-trail';
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

/** How far back a workflow's recent instances are counted: the 24 hours the list shows. */
const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** How busy one workflow is: what the workflow list shows beside each row. */
export interface WorkflowRunCounts {
  /** Instances that have not finished: pending, running, or suspended. */
  readonly active: number;
  /** Instances created in the last 24 hours. */
  readonly last24Hours: number;
  /** When the newest instance was created, or `null` when the workflow has had none. */
  readonly lastRunAt: string | null;
}

export interface WorkflowRunFilter {
  readonly workflow?: string | undefined;
  readonly status?: WorkflowStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** Who made a write, for the audit trail. */
export interface WorkflowWriteContext {
  /**
   * The actor the audit entry names: `agent-run:<runId>` for a write a tool made, the calling
   * principal's owner string for one made over HTTP. Absent for a caller that cannot be attributed.
   */
  readonly actor?: string | undefined;
}

/** What `workflows.signal` did: the instances it started and the ones it delivered to. */
export interface WorkflowSignalResult {
  /** The identifiers of the instances it started, one for each matching workflow. */
  readonly started: string[];
  /** The identifiers of the running instances whose `await-signal` wait it satisfied. */
  readonly delivered: string[];
}

/** The audit entry types a write to a workflow file appends. */
export type WorkflowAuditType =
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.paused'
  | 'workflow.resumed'
  | 'workflow.deleted';

/** One entry a write appends to the audit trail, filed under `workflow:<identifier>`. */
export interface WorkflowAuditEntry {
  readonly runId: string;
  readonly type: WorkflowAuditType;
  readonly detail: { readonly id: string; readonly hash: string; readonly previousHash?: string };
  readonly principal?: string;
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
    context?: WorkflowWriteContext,
  ) => Promise<WorkflowFileWriteResult>;
  readonly update: (
    id: string,
    definition: WorkflowFileDefinition,
    options: { readonly expectedHash: string } & WorkflowWriteContext,
  ) => Promise<WorkflowFileWriteResult>;
  readonly pause: (
    id: string,
    options: { readonly expectedHash: string } & WorkflowWriteContext,
  ) => Promise<WorkflowFileWriteResult>;
  readonly resume: (
    id: string,
    options: { readonly expectedHash: string } & WorkflowWriteContext,
  ) => Promise<WorkflowFileWriteResult>;
  readonly delete: (
    id: string,
    options: { readonly expectedHash: string } & WorkflowWriteContext,
  ) => Promise<WorkflowFileWriteResult>;
  /** The revisions of `id` that have run, newest first; `undefined` when there is no such workflow. */
  readonly revisions: (id: string) => Promise<readonly WorkflowRevision[] | undefined>;
  readonly listRuns: (filter: WorkflowRunFilter) => Promise<{
    readonly runs: readonly WorkflowRunSummary[];
    readonly nextOffset: number | null;
  }>;
  readonly getRun: (runId: string) => Promise<WorkflowRunDetail | undefined>;
  /** The counts of `id`'s instances, read from the engine's own totals. */
  readonly runCounts: (id: string) => Promise<WorkflowRunCounts>;
  /** Rescan the directory; resolves once the engine and the schedules match it. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed a workflow. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DirectoryChange) => void) => () => void;
  /**
   * Throws `BureauError` `NOT_FOUND` unless `id` is a ready, unpaused workflow: the check a path
   * that starts a workflow by identifier (`signal`) makes, so a paused or deleted workflow is
   * refused as if it did not exist.
   */
  readonly assertStartable: (id: string) => void;
  /**
   * Deliver a signal named `name` and start what it triggers (COR-1528), in that order. First
   * `payload` goes to every running instance of a workflow file that is waiting at an
   * `await-signal` step of that name, including the instances of a paused or deleted workflow,
   * which still finish. Then one instance starts for each ready, unpaused workflow whose trigger
   * is `{ kind: 'signal', name }`, with `{ kind: 'signal', name, payload }` as its `trigger`; an
   * instance this call starts is never satisfied by this call's delivery, because the delivery
   * is over before it starts. `signalId` is forwarded to Weft's signal delivery, so a delivery
   * retried with the same `signalId` is applied once; starts are not deduplicated. It takes no
   * owner: every workflow file belongs to the deployment's owner, and whether a caller may signal
   * is the operation's decision.
   */
  readonly signal: (
    name: string,
    payload: unknown,
    options?: { readonly signalId?: string | undefined },
  ) => Promise<WorkflowSignalResult>;
}

/**
 * Applying the workflow files to the engine failed: the file was written, but the engine or a
 * schedule did not follow it. The next rescan applies it again.
 */
export class WorkflowApplyError extends Error {
  readonly code = 'workflow-apply-failed';
  constructor(cause: unknown) {
    super(
      `The change was written to the workflow file, but the engine did not follow it, and will be updated again on the next rescan: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'WorkflowApplyError';
  }
}

/**
 * A signal that stopped partway: delivering it failed, or the engine had not followed an earlier
 * change to the files. Nothing was started. `delivered` lists the instances the signal had already
 * reached, which a retry with the same `signalId` reaches again without applying it twice.
 */
export class WorkflowSignalFailure extends Error {
  readonly code: 'signal-delivery-failed' | 'workflow-apply-failed';
  readonly delivered: readonly string[];
  constructor(
    code: 'signal-delivery-failed' | 'workflow-apply-failed',
    message: string,
    delivered: readonly string[],
    cause: unknown,
  ) {
    super(`${message} Delivered to: ${delivered.length === 0 ? 'none' : delivered.join(', ')}.`, {
      cause,
    });
    this.name = 'WorkflowSignalFailure';
    this.code = code;
    this.delivered = delivered;
  }
}

/** The engine's payload cap from `durableGuardrails.payloadSize`: a positive size, or `null` for none. */
export function payloadMaximumBytesOf(
  payloadSize: { readonly maxBytes?: number | null | undefined } | undefined,
): number | null {
  const maximum = payloadSize?.maxBytes;
  return typeof maximum === 'number' && maximum > 0 ? maximum : null;
}

/** The longest `signalId` Weft admits, in UTF-8 bytes. */
export const SIGNAL_ID_MAXIMUM_BYTES = 128;

/** What {@link WorkflowRuntime.start} registered as `retained`. */
export interface WorkflowStartReport {
  readonly retained: readonly { readonly id: string; readonly workflowVersion: string }[];
}

/** In-flight instances Bureau cannot register a revision for. */
interface Unrecoverable {
  readonly id: string;
  readonly workflowVersion: string;
  readonly runIds: readonly string[];
  readonly reason: string;
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
  readonly createError: (message: string, code: 'NOT_FOUND' | 'BAD_REQUEST') => Error;
  /**
   * The engine's cap on one payload's encoded size, or `null` for none. A signal's payload and the
   * trigger it starts an instance with are checked against it before anything is delivered.
   */
  readonly payloadMaximumBytes?: number | null | undefined;
  /** Registers background work with the Bureau, so a test can wait for it to settle. */
  readonly track?: ((promise: Promise<unknown>, label: string) => void) | undefined;
  /**
   * Appends an entry to the audit trail for a write that changed a workflow file. Optional: a
   * Bureau with no persistent storage keeps no trail.
   */
  readonly audit?: ((entry: WorkflowAuditEntry) => Promise<void>) | undefined;
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
    afterScan: () => {
      if (applyPending) queueApply();
    },
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

  /**
   * The instances of `type` that have not finished, by the `workflowVersion` each is pinned to, with
   * the earliest start of each version.
   */
  async function inFlightRuns(
    type: string,
  ): Promise<Map<string, { startedAt: number; runIds: string[] }>> {
    const byVersion = new Map<string, { startedAt: number; runIds: string[] }>();
    for (let offset = 0; ;) {
      const page = await engine.list({ type, status: [...IN_FLIGHT_STATUSES], limit: 100, offset });
      for (const summary of page.items) {
        const known = byVersion.get(summary.version);
        if (known === undefined) {
          byVersion.set(summary.version, { startedAt: summary.createdAt, runIds: [summary.id] });
        } else {
          known.startedAt = Math.min(known.startedAt, summary.createdAt);
          known.runIds.push(summary.id);
        }
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return byVersion;
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

  /** Whether `id` is the name of a workflow the engine has from code, not one Bureau registered. */
  const isCodeName = (id: string): boolean =>
    engine.getWorkflowDefinition(id) !== undefined && !registeredTypes.has(id);

  /**
   * What startup does about the in-flight instances of the workflow files: the stored documents of
   * the revisions that are not any file's current one, to register as `retained`, and the
   * instances Bureau cannot register a revision for at all.
   *
   * An instance whose type has no registration makes the engine's default `recoverAll()` refuse
   * the whole batch, so one such instance would strand every durable run in the store on every
   * boot. Each is therefore cancelled (see {@link cancelUnrecoverable}) before the engine
   * recovers, with a reason an operator can read. This is the first line of defence: Bureau also
   * recovers with `acknowledgeUnknownWorkflowTypes`, which skips and reports what has no trace
   * here at all (COR-1583).
   */
  async function planRecovery(): Promise<{
    retained: { id: string; version: string; document: WorkflowDocument }[];
    unrecoverable: Unrecoverable[];
  }> {
    const identifiers = new Set([
      ...catalog.list().map((listing) => listing.id),
      ...(await snapshots.identifiers()),
    ]);
    const retained: { id: string; version: string; document: WorkflowDocument }[] = [];
    const unrecoverable: Unrecoverable[] = [];
    for (const id of identifiers) {
      const current = catalog.find(id)?.version;
      const collides = isCodeName(id);
      // When the name is a code workflow's, only an instance pinned to a revision Bureau stored is
      // Bureau's; the code workflow's own instances are left alone.
      const storedRevisions = collides ? await snapshots.snapshotsOf(id) : [];
      const stored = collides
        ? new Set(storedRevisions.map((snapshot) => snapshot.workflowVersion))
        : undefined;
      const inFlight = await inFlightRuns(id);
      for (const [version, { startedAt, runIds }] of inFlight) {
        if (stored !== undefined && !stored.has(version)) continue;
        // An instance that started before a crash can have lost its history stamp: restore it.
        await snapshots.stampRun(id, version, new Date(startedAt).toISOString());
        if (version === current) continue;
        const cannot = (reason: string): void => {
          unrecoverable.push({ id, workflowVersion: version, runIds, reason });
        };
        if (collides) {
          cannot(`workflow "${id}" is now the name of a code-defined workflow`);
          continue;
        }
        let snapshot: WorkflowSnapshot | undefined;
        try {
          snapshot = await snapshots.load(id, version);
        } catch (error) {
          cannot(
            `the stored revision ${version} of workflow "${id}" cannot be used (${error instanceof Error ? error.message : String(error)})`,
          );
          continue;
        }
        if (snapshot === undefined) {
          cannot(`the revision ${version} of workflow "${id}" is not stored`);
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
          cannot(
            `the stored revision ${version} of workflow "${id}" no longer validates against this Bureau (${error.message})`,
          );
        }
      }
    }
    return { retained, unrecoverable };
  }

  /**
   * Cancel every instance in `unrecoverable` through the engine, which accepts a stored instance
   * that has not been recovered. The reason is recorded first, so a crash between the two leaves
   * the instance to be cancelled again at the next boot, and each cancellation is reported as an
   * error naming the instance, the workflow, and why. The instance stays readable through
   * `bureau.workflows.runs.*`, ending `cancelled` with that reason.
   */
  async function cancelUnrecoverable(unrecoverable: readonly Unrecoverable[]): Promise<void> {
    for (const entry of unrecoverable) {
      for (const runId of entry.runIds) {
        const reason = `Cancelled at startup because it cannot resume: ${entry.reason}.`;
        try {
          await snapshots.recordCancellation({
            schemaVersion: 1,
            runId,
            id: entry.id,
            workflowVersion: entry.workflowVersion,
            reason,
            cancelledAt: options.runtime.clock.nowISO(),
          });
          await engine.cancel(runId);
          options.diagnose(
            `Cancelled instance "${runId}" of workflow "${entry.id}": ${entry.reason}.`,
            undefined,
          );
        } catch (error) {
          options.diagnose(
            `Could not cancel instance "${runId}" of workflow "${entry.id}", which cannot resume (${entry.reason}); recovery of the engine may refuse it.`,
            error,
          );
        }
      }
    }
  }

  /** The failure of the latest apply, until a later one succeeds. */
  let applyFailure: unknown;
  /** Whether the engine may be behind the files, so that the next rescan applies them again. */
  let applyPending = false;
  let applyQueued = false;

  async function applyChange(): Promise<void> {
    applyQueued = false;
    if (closed) return;
    try {
      await register([]);
      await reconcileWorkflowSchedules(engine, desiredSchedules());
      applyFailure = undefined;
      applyPending = false;
    } catch (error) {
      applyFailure = error;
      applyPending = true;
      options.diagnose('Could not bring the engine in line with the workflow files.', error);
    }
  }

  /** Queue one apply behind the work in progress, unless one is already queued. */
  function queueApply(): void {
    if (applyQueued || closed) return;
    applyQueued = true;
    track(exclusive(applyChange), 'workflow-files-apply');
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
      queueApply();
    });
    stopListening = () => {
      engine.removeEventListener('workflow:started', onStarted);
      unsubscribe();
    };
    return exclusive(async () => {
      await catalog.refresh();
      const { retained, unrecoverable } = await planRecovery();
      await register(retained.map((entry) => entry.document));
      await cancelUnrecoverable(unrecoverable);
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

  /**
   * Append the entry for a write that changed a file. A write that changed nothing (a no-op update,
   * pausing a paused workflow) is not an event. The trail is best effort, so a failure to write it
   * is reported and never fails the write.
   */
  async function audit(
    type: WorkflowAuditType,
    result: WorkflowFileWriteResult,
    actor: string | undefined,
    previousHash: string | undefined,
  ): Promise<void> {
    if (options.audit === undefined) return;
    if (previousHash !== undefined && result.hash === previousHash) return;
    try {
      await options.audit({
        runId: auditTrailWorkflowOwnerId(result.id),
        type,
        detail: {
          id: result.id,
          hash: result.hash,
          ...(previousHash === undefined ? {} : { previousHash }),
        },
        ...(actor === undefined ? {} : { principal: actor }),
      });
    } catch (error) {
      options.diagnose(`Could not record the ${type} audit entry for "${result.id}".`, error);
    }
  }

  /**
   * Run a write to a workflow file, record it, and wait until the engine and the schedules have
   * followed it. A write whose apply failed is reported as a failure, because the file now says
   * one thing and the engine another; the next rescan applies it again. The audit entry is written
   * either way, because the file did change.
   *
   * `previousHash` is the hash the write was guarded by, so a write that left the bytes as they
   * were records nothing; `create` and `delete` have none and always record.
   */
  async function write(
    type: WorkflowAuditType,
    context: WorkflowWriteContext | undefined,
    previousHash: string | undefined,
    work: () => Promise<WorkflowFileWriteResult>,
  ): Promise<WorkflowFileWriteResult> {
    const result = await work();
    await audit(type, result, context?.actor, previousHash);
    if (applyPending) queueApply();
    await settled();
    if (applyFailure !== undefined) throw new WorkflowApplyError(applyFailure);
    return result;
  }

  /** The identifiers of the running instances of `type`, read before any is signalled. */
  async function runningInstances(type: string): Promise<string[]> {
    const identifiers: string[] = [];
    for (let offset = 0; ;) {
      const page = await engine.list({ type, status: ['running'], limit: 100, offset });
      identifiers.push(...page.items.map((summary) => summary.id));
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return identifiers;
    }
  }

  /**
   * Refuse, before any effect, what the engine would refuse: an empty name, a `signalId` that is
   * empty or over Weft's 128 bytes (counted in UTF-8 bytes, not characters), a payload that is not
   * a JSON value, and a payload that cannot be encoded or is over the engine's payload limit, which
   * also bounds the trigger an instance it starts is given.
   */
  function validateSignal(name: string, payload: unknown, signalId: string | undefined): void {
    const refuse = (message: string): never => {
      throw options.createError(message, 'BAD_REQUEST');
    };
    if (name === '') refuse('A signal needs a non-empty name.');
    if (signalId !== undefined) {
      if (signalId === '') refuse('"signalId" must be non-empty.');
      if (new TextEncoder().encode(signalId).byteLength > SIGNAL_ID_MAXIMUM_BYTES) {
        refuse(`"signalId" must be at most ${String(SIGNAL_ID_MAXIMUM_BYTES)} bytes.`);
      }
    }
    // An agent step renders the trigger with JSON.stringify, so a value the engine can encode but
    // JSON cannot (a Map, a Set, a bigint, NaN) would reach it altered or make it throw after this
    // call reported success.
    if (payload !== undefined && !z.json().safeParse(payload).success) {
      refuse("The signal's payload must be a JSON value.");
    }
    const limit = options.payloadMaximumBytes ?? null;
    for (const value of [payload, { kind: 'signal', name, payload }]) {
      let size: number;
      try {
        size = encode(value).byteLength;
      } catch (error) {
        return refuse(
          `The signal's payload cannot be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (limit !== null && size > limit) {
        refuse(
          `The signal's payload is ${String(size)} bytes encoded, over the engine's ${String(limit)} byte limit.`,
        );
      }
    }
  }

  /**
   * Deliver `payload` to every running instance of a workflow file that waits at `name`, and return
   * the instances it reached. The state is read again right before each delivery, so an instance
   * that was cancelled or finished since the listing is skipped. That narrows the window and does
   * not close it: Weft drops a signal sent to a finished instance without saying so, and a signal
   * and a finish can still cross. Any error from the engine stops the delivery, and is reported
   * with what was already reached.
   */
  async function deliverSignal(
    name: string,
    payload: unknown,
    signalId: string | undefined,
  ): Promise<string[]> {
    const delivered: string[] = [];
    const waitsAt = async (id: string): Promise<boolean> => {
      const state = await engine.get(id);
      return state?.status === 'running' && state.waitingForSignals?.includes(name) === true;
    };
    try {
      for (const type of [...registeredTypes].toSorted()) {
        for (const id of await runningInstances(type)) {
          if (!(await waitsAt(id))) continue;
          // Read again, right before the delivery: the listing and the first read can be stale.
          if (!(await waitsAt(id))) continue;
          await engine.signal(id, name, payload, signalId === undefined ? undefined : { signalId });
          delivered.push(id);
        }
      }
    } catch (error) {
      throw new WorkflowSignalFailure(
        'signal-delivery-failed',
        `The signal "${name}" could not be delivered to every waiting instance (${error instanceof Error ? error.message : String(error)}), so it was not delivered further and nothing was started.`,
        delivered,
        error,
      );
    }
    return delivered;
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

    create: (id, definition, context) =>
      write('workflow.created', context, undefined, () => catalog.create(id, definition)),
    update: (id, definition, update) =>
      write('workflow.updated', update, update.expectedHash, () =>
        catalog.update(id, definition, update),
      ),
    pause: (id, guard) =>
      write('workflow.paused', guard, guard.expectedHash, () => catalog.setPaused(id, true, guard)),
    resume: (id, guard) =>
      write('workflow.resumed', guard, guard.expectedHash, () =>
        catalog.setPaused(id, false, guard),
      ),
    delete: (id, guard) =>
      write('workflow.deleted', guard, undefined, () => catalog.delete(id, guard)),

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

    async runCounts(id) {
      const [active, recent, newest] = await Promise.all([
        engine.list({ type: id, status: [...IN_FLIGHT_STATUSES], limit: 1 }),
        engine.list({ type: id, createdAt: { gte: Date.now() - RECENT_RUN_WINDOW_MS }, limit: 1 }),
        // The engine lists newest first, so the first item of an unfiltered page is the last run.
        engine.list({ type: id, limit: 1 }),
      ]);
      const last = newest.items[0];
      return {
        active: active.total,
        last24Hours: recent.total,
        lastRunAt: last === undefined ? null : new Date(last.createdAt).toISOString(),
      };
    },

    async getRun(runId) {
      const state: WorkflowState | null | undefined = await engine.get(runId);
      if (state === null || state === undefined || !(await isWorkflowType(state.type))) {
        return undefined;
      }
      // Weft's cancellation carries no reason; one Bureau cancelled at startup has its own.
      const cancellation =
        state.error === undefined && state.status === 'cancelled'
          ? await snapshots.cancellationOf(runId)
          : undefined;
      const error = state.error ?? cancellation?.reason;
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
        ...(error === undefined ? {} : { error }),
      };
    },

    async refresh() {
      await catalog.refresh();
      await settled();
    },

    async signal(name, payload, signalOptions) {
      // Delivery first, and it finishes before any instance starts, so an instance this call
      // starts whose first step awaits `name` is not satisfied by the payload it was started with.
      validateSignal(name, payload, signalOptions?.signalId);
      const delivered = await deliverSignal(name, payload, signalOptions?.signalId);
      if (applyPending) queueApply();
      await settled();
      if (applyFailure !== undefined) {
        throw new WorkflowSignalFailure(
          'workflow-apply-failed',
          new WorkflowApplyError(applyFailure).message,
          delivered,
          applyFailure,
        );
      }
      const trigger = { kind: 'signal', name, payload: payload ?? null };
      const startedIds: string[] = [];
      for (const listing of catalog.list()) {
        const file = catalog.find(listing.id);
        if (file?.document.trigger.kind !== 'signal' || file.document.trigger['name'] !== name) {
          continue;
        }
        try {
          workflows.assertStartable(file.id);
        } catch {
          continue;
        }
        const handle = await engine.start(file.id, trigger);
        startedIds.push(handle.id);
      }
      return { started: startedIds, delivered };
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
      const inFlight = new Map<string, Map<string, unknown>>();
      const versionsOf = async (type: string) => {
        const cached = inFlight.get(type);
        if (cached !== undefined) return cached;
        const found = await inFlightRuns(type);
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
          hasInFlight: async (id) => {
            const pinned = await versionsOf(id);
            return pinned.size > 0;
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
