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
  buildWorkflowDocumentManifest,
  checkWorkflowCompatibility,
  type DocumentWorkflowHost,
  encode,
  type Engine,
  type RegisteredWorkflowDocument,
  WorkflowDocumentValidationError,
  type WorkflowCompatibilityVerdict,
  type WorkflowDocument,
  type WorkflowState,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { z } from 'zod';

import { auditTrailWorkflowOwnerId } from './audit-trail';
import { taskOriginTag, type TaskOrigin, type TaskPersonSurface } from './task-origin';
import { ownerOrLocal } from './owner-of-record';
import type { DefinitionChange, DefinitionScannerHealth } from './definition-scanner';
import type { WorkflowSource } from './sources/definition-source';
import { triggerHasUnrecognizedKeys, type WorkflowFileDefinition } from './workflow-file';
import {
  createWorkflowFileCatalog,
  type ReadyWorkflowFile,
  type WorkflowFileCatalog,
  type WorkflowFileWriteResult,
  type WorkflowListing,
} from './workflow-file-catalog';
import type { ScheduleHookOrigins } from './hooks/schedule-hook-origins';
import { toWeftDocument, validateBureauWorkflowDocument } from './workflow-document-handlers';
import {
  bridgeEngineActivities,
  registerBureauWorkflowDocuments,
  type ScheduleOverlapPolicy,
} from './workflow-host';
import {
  type DesiredWorkflowSchedule,
  parseWorkflowScheduleId,
  reconcileWorkflowSchedules,
} from './workflow-schedule';
import {
  finishReasonOf,
  inputSchemaIssues,
  type WorkflowFinishReason,
  WorkflowInputInvalidError,
  type WorkflowSchemaIssue,
} from './workflow-schema';
import {
  createWorkflowSnapshotStore,
  WorkflowSnapshotError,
  type WorkflowRevision,
  type WorkflowSnapshot,
  type WorkflowSnapshotStore,
} from './workflow-snapshot-store';

/** The statuses of an instance that has not finished: the runs whose revision must stay loadable. */
const IN_FLIGHT_STATUSES: readonly WorkflowStatus[] = ['pending', 'running', 'suspended'];

/** How far back a workflow's recent instances are counted: the 24 hours the list shows. */
const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The wider window a quiet workflow's newest instance is looked for in before its whole history is. */
const QUIET_RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  /**
   * `input-invalid` or `output-invalid` when the instance failed because its input or its result
   * broke the workflow's schema (the issues are in `error`), and `null` otherwise.
   */
  readonly finishReason: WorkflowFinishReason | null;
}

/** What {@link BureauWorkflows.start} started. */
export interface WorkflowStartResult {
  /** The identifier of the instance, for `runs.get`. */
  readonly runId: string;
  /** The workflow that was started. */
  readonly workflow: string;
  /** The revision the instance is pinned to, as the started run reports it. */
  readonly workflowVersion: string;
}

/** Who started a workflow and from where, for {@link BureauWorkflows.start}. */
export interface WorkflowStartOptions {
  /** The input the workflow's `inputSchema` describes; absent is `null`. */
  readonly input?: unknown;
  /** The principal that started it, recorded as the instance's owner. */
  readonly owner: string;
  /** Where the person started it from; `api` unless the caller says. */
  readonly surface?: TaskPersonSurface | undefined;
  /**
   * Makes the start at-most-once (Weft's `idempotencyKey`): a second start with the same key
   * starts nothing and answers the instance the first one started, however long ago and whether or
   * not that instance has finished. A hook's `start-workflow` action sets it, so a delivery that is
   * retried or resumed starts one instance.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * Tags the instance carries beside the one that mirrors its origin. A hook's `start-workflow`
   * action marks the instance it starts, so the Bureau can tell that a hook started it.
   */
  readonly tags?: readonly string[] | undefined;
}

/**
 * A workflow file's source as a code-defined workflow has one. A code workflow has no file, so
 * its `text` is its description and its registered contract, not code.
 */
export interface WorkflowCodeDetail {
  /** The workflow's type name. */
  readonly id: string;
  /** What the workflow is for, in a sentence, or `null` when the code declares none. */
  readonly description: string | null;
  /** The workflow's Weft `version`, or `null` when it declares none. */
  readonly version: string | null;
  /** Always `code`: this workflow is registered by code, not by a file. */
  readonly source: { readonly kind: 'code'; readonly text: string };
}

/**
 * The source of the workflow `id` the engine has from code, or `undefined` when it has none. It
 * does not know which names a workflow directory registered: a caller that has a directory
 * excludes those itself, as `getCode` does, and one without a directory has none to exclude.
 */
export function describeCodeWorkflow(
  engine: Pick<Engine, 'getWorkflowDefinition'>,
  id: string,
): WorkflowCodeDetail | undefined {
  const definition = engine.getWorkflowDefinition(id);
  if (definition === undefined) return undefined;
  const description = definition.description ?? null;
  const contract = {
    type: definition.type,
    version: definition.version,
    tags: [...definition.tags],
    signals: Object.keys(definition.signals ?? {}),
    updates: Object.keys(definition.updates ?? {}),
    queries: Object.keys(definition.queries ?? {}),
    uses: Object.keys(definition.uses ?? {}),
  };
  const text = `${description === null ? '' : `${description}\n\n`}${JSON.stringify(contract, null, 2)}\n`;
  return {
    id,
    description,
    version: definition.version === '' ? null : definition.version,
    source: { kind: 'code', text },
  };
}

/** A revision of a workflow that has run, with whether it is compatible with the workflow's current revision. */
export interface WorkflowRevisionReport extends WorkflowRevision {
  /**
   * Weft's compatibility verdict for this revision against the file's current revision
   * (`checkWorkflowCompatibility` over the manifests of the two documents): `{ compatible: true }`,
   * or `{ compatible: false, reasons }` naming every applicable reason. The current revision is
   * compatible with itself. `null` when there is nothing to compare: the workflow has no file now
   * (it was deleted, or its file is invalid), or a manifest could not be built from a document.
   */
  readonly compatibility: WorkflowCompatibilityVerdict | null;
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
  /**
   * The hook that started the run that made the write (COR-1952), set by the workflow tools from
   * the calling run and by nothing else. A `create` or `update` that carries it records the hook as
   * the origin of the file's schedule, so the schedule's fires are read as that hook's runs and
   * start no `start-workflow` hook. It is recorded before the file is written and put back if the
   * write fails. A `create` without it clears any origin left under the identifier; an `update`
   * without it leaves the origin as it is.
   */
  readonly hookOrigin?: string | undefined;
}

/** What `workflows.signal` did: the instances it started and the ones it delivered to. */
export interface WorkflowSignalResult {
  /** The identifiers of the instances it started, one for each matching workflow. */
  readonly started: string[];
  /** The identifiers of the running instances whose `await-signal` wait it satisfied. */
  readonly delivered: string[];
  /**
   * The workflows whose signal trigger matched but whose `inputSchema` the payload does not
   * satisfy, with every issue. No instance was started for them; the others started as usual.
   */
  readonly rejected: { readonly id: string; readonly issues: readonly WorkflowSchemaIssue[] }[];
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
  /**
   * The revisions of `id` that have run, newest first, each with its compatibility verdict against
   * the workflow's current revision; `undefined` when there is no such workflow.
   */
  readonly revisions: (id: string) => Promise<readonly WorkflowRevisionReport[] | undefined>;
  readonly listRuns: (filter: WorkflowRunFilter) => Promise<{
    readonly runs: readonly WorkflowRunSummary[];
    readonly nextOffset: number | null;
  }>;
  readonly getRun: (runId: string) => Promise<WorkflowRunDetail | undefined>;
  /**
   * The counts of `id`'s instances, read from the engine's own totals, or `null` when the engine
   * could not be read (the failure is reported through the Bureau's diagnostics).
   */
  readonly runCounts: (id: string) => Promise<WorkflowRunCounts | null>;
  /**
   * Start an instance of the ready, unpaused workflow `id` (COR-1812): the one start that names a
   * workflow. `input` is checked against the file's `inputSchema` first, and an input that fails
   * throws {@link WorkflowInputInvalidError} with every issue and starts nothing. The instance is
   * started with the trigger `{ kind: 'manual', input, origin }`, where `origin` is the `person`
   * origin (COR-1867) naming `owner`, and with the tag that mirrors it. It throws `NOT_FOUND`
   * for a workflow that is missing, invalid, or paused, as `signal` does.
   */
  readonly start: (id: string, options: WorkflowStartOptions) => Promise<WorkflowStartResult>;
  /**
   * The instance a {@link start} with this `idempotencyKey` created, or `undefined` when no start
   * with it has committed (COR-1951). Read-only, and it does not look at the workflow file: it
   * answers even after the file was edited, paused, or deleted, so a caller that cannot tell
   * whether its start committed (a crash before its own receipt) can find out before it
   * validates or starts anything. Throws Weft's `IdempotencyKeyPurgedError` when the key was used
   * but its instance has been purged, as `start` does.
   */
  readonly findStart: (idempotencyKey: string) => Promise<WorkflowStartResult | undefined>;
  /**
   * The source of the code-defined workflow `id`, or `undefined` when the engine has no such
   * workflow or `id` is a workflow Bureau registered from a file (read those with `get`).
   */
  readonly getCode: (id: string) => WorkflowCodeDetail | undefined;
  /** Rescan the directory; resolves once the engine and the schedules match it. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed a workflow. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
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
  /** When the workflow directory was last scanned and the message of that scan's error (COR-1731). */
  readonly health: () => DefinitionScannerHealth;
  /** Stop watching and wait for work in flight. */
  readonly close: () => Promise<void>;
}

export interface WorkflowRuntimeOptions {
  /** Where the workflow files come from and are written back to. */
  readonly source: WorkflowSource;
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
  /**
   * Where the hook that started the run that wrote a workflow's file is recorded (COR-1952), so the
   * file's schedule carries it. Absent for a Bureau with no key-value store.
   */
  readonly hookOrigins?:
    | Pick<
        ScheduleHookOrigins,
        'recordWorkflow' | 'clearWorkflow' | 'hookOfWorkflow' | 'workflowsWithOrigin'
      >
    | undefined;
  /** Registers background work with the Bureau, so a test can wait for it to settle. */
  readonly track?: ((promise: Promise<unknown>, label: string) => void) | undefined;
  /**
   * Appends an entry to the audit trail for a write that changed a workflow file. Optional: a
   * Bureau with no persistent storage keeps no trail.
   */
  readonly audit?: ((entry: WorkflowAuditEntry) => Promise<void>) | undefined;
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
  const { engine, snapshotStore: snapshots } = options;
  const host = bridgeEngineActivities(engine, options.host);
  const owner = ownerOrLocal(undefined);
  /** The workflow types Bureau registered from a file in this process. */
  const registeredTypes = new Set<string>();
  /** Stamps of a revision's runs that have not finished being written. */
  const pendingStamps = new Set<Promise<unknown>>();
  let closed = false;
  let started = false;

  const catalog: WorkflowFileCatalog = createWorkflowFileCatalog({
    source: options.source,
    host,
    // A name the engine already has that Bureau did not register itself is a code workflow.
    isCodeWorkflow: (id) =>
      engine.getWorkflowDefinition(id) !== undefined && !registeredTypes.has(id),
    runtime: options.runtime,
    diagnose: options.diagnose,
    afterScan: () => {
      if (applyPending) queueApply();
    },
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

  /** The `id:hash` of every unreadable file already reported, so a rescan does not repeat it. */
  const reportedUnreadable = new Set<string>();

  /**
   * The workflows whose file holds a key this host does not know (COR-1927): written by a newer
   * Bureau, as a rolling deploy shows an older one. This host cannot judge such a file, so it
   * leaves the file's schedule and instances as they are, and says so once per version of the file.
   */
  function unreadableWorkflows(): Set<string> {
    const unreadable = new Set<string>();
    for (const listing of catalog.list()) {
      if (listing.problem?.unrecognizedKeys !== true) continue;
      unreadable.add(listing.id);
      const reported = `${listing.id}:${listing.hash ?? ''}`;
      if (reportedUnreadable.has(reported)) continue;
      reportedUnreadable.add(reported);
      options.diagnose(
        `Workflow "${listing.id}" has a key this Bureau does not know, so its schedule and its instances in flight are left as they are until a Bureau that knows it reads the file: ${listing.problem.message}`,
        undefined,
      );
    }
    return unreadable;
  }

  /** Put the schedules in line with the files, leaving the unreadable ones as they are. */
  async function reconcileSchedules(): Promise<void> {
    await reconcileWorkflowSchedules(engine, desiredSchedules(), unreadableWorkflows());
    await forgetVanishedHookOrigins();
  }

  /** The identifiers a write is between claiming the hook origin of and listing the file for. */
  const writingOrigins = new Set<string>();

  /**
   * Hook origins left on record for a workflow whose file is gone while an instance of it was still
   * live. The record stays, because that instance's events are attributed through it, and goes at
   * the first reconcile that finds the workflow with no live instance or with a file again.
   */
  const orphanedOrigins = new Set<string>();

  /** Whether an instance of workflow `id` has not finished. */
  async function hasLiveInstances(id: string): Promise<boolean> {
    const page = await engine.list({
      type: id,
      status: ['pending', 'running', 'suspended'],
      limit: 1,
    });
    return page.items.length > 0;
  }

  /**
   * Forget the hook origin of every workflow that has no file any more (COR-1952), so a file an
   * owner adds later under the identifier is not read as a hook's. A file removed by hand never
   * passes through a write, so this runs with every reconcile. A file listed as invalid or
   * unreadable still counts as there. A record is kept while an instance of its workflow is live
   * (see {@link orphanedOrigins}): the instance's `run.settled` is still read through it.
   */
  async function forgetVanishedHookOrigins(): Promise<void> {
    const origins = options.hookOrigins;
    if (origins === undefined) return;
    const present = new Set(catalog.list().map((listing) => listing.id));
    for (const id of await origins.workflowsWithOrigin()) {
      if (writingOrigins.has(id)) continue;
      if (present.has(id)) {
        // A file under an identifier whose old file went while it ran is the owner's.
        if (orphanedOrigins.delete(id)) await origins.clearWorkflow(id);
        continue;
      }
      if (await hasLiveInstances(id)) {
        orphanedOrigins.add(id);
        continue;
      }
      orphanedOrigins.delete(id);
      await origins.clearWorkflow(id);
    }
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
      const retainedBefore = retained.length;
      const unrecoverableBefore = unrecoverable.length;
      let leftAlone = false;
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
          if (error instanceof WorkflowSnapshotError && error.unrecognizedKeys) {
            // A newer Bureau wrote this revision: its instances are that Bureau's to resume, and
            // cancelling them here would end runs this Bureau cannot even read (COR-1927).
            leftAlone = true;
            options.diagnose(
              `The stored revision ${version} of workflow "${id}" has a key this Bureau does not know, so its ${String(runIds.length)} instance(s) in flight are left as they are: ${error.message}`,
              undefined,
            );
            continue;
          }
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
            document: validateBureauWorkflowDocument(snapshot.document, host),
          });
        } catch (error) {
          if (!(error instanceof WorkflowDocumentValidationError)) throw error;
          if (triggerHasUnrecognizedKeys(snapshot.document.trigger)) {
            // The stored trigger carries an option a newer Bureau added: its instances are that
            // Bureau's to resume, as with an unrecognized key in the snapshot itself (COR-1927).
            leftAlone = true;
            options.diagnose(
              `The stored revision ${version} of workflow "${id}" has a trigger key this Bureau does not know, so its ${String(runIds.length)} instance(s) in flight are left as they are: ${error.message}`,
              undefined,
            );
            continue;
          }
          cannot(
            `the stored revision ${version} of workflow "${id}" no longer validates against this Bureau (${error.message})`,
          );
        }
      }
      if (leftAlone && current === undefined) {
        // No file of this workflow is readable here, so registering an older revision of it would
        // have the engine fail the instances pinned to the one this Bureau cannot read. Register
        // nothing and cancel nothing: the engine skips and reports a type it has no trace of, and a
        // Bureau that reads the workflow resumes every instance.
        retained.length = retainedBefore;
        unrecoverable.length = unrecoverableBefore;
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
      await reconcileSchedules();
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
      await reconcileSchedules();
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

  /** The tail of the writes to each workflow that carries a hook origin, so two never interleave. */
  const writeTails = new Map<string, Promise<unknown>>();

  /**
   * Run `work` after every write to workflow `id` that is already waiting, and before any later one.
   * The hook origin is claimed, the file written and the claim rolled back inside one turn of it, so
   * a write that loses a hash check puts back the origin it read, which no other write changed in
   * between. Without an `id` it just runs.
   */
  async function serializedPerWorkflow<T>(
    id: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (id === undefined) return work();
    const run = (writeTails.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    writeTails.set(id, tail);
    try {
      return await run;
    } finally {
      if (writeTails.get(id) === tail) writeTails.delete(id);
    }
  }

  /**
   * Put the hook that started the writing run on the file's schedule (COR-1952) before the file is
   * written, so the file's schedule cannot be applied, and fire, before its origin is readable. A
   * file created without a hook's origin clears any a previous file under the identifier left; an
   * update without one keeps what is there. A `create` of an identifier that already has a file
   * leaves the record alone, because it will be refused and the file keeps its own origin.
   * Returns what puts the record back as it was, for a write that then fails.
   */
  async function claimHookOrigin(
    type: WorkflowAuditType,
    id: string | undefined,
    hookOrigin: string | undefined,
  ): Promise<() => Promise<void>> {
    const origins = options.hookOrigins;
    const unchanged = async (): Promise<void> => {};
    if (origins === undefined || id === undefined) return unchanged;
    // A file written under the identifier again is no longer one whose record is waiting to go.
    orphanedOrigins.delete(id);
    if (type === 'workflow.created') {
      if (catalog.list().some((listing) => listing.id === id)) return unchanged;
    } else if (type !== 'workflow.updated' || hookOrigin === undefined) {
      return unchanged;
    }
    const prior = await origins.hookOfWorkflow(id);
    if (prior === hookOrigin) return unchanged;
    if (hookOrigin === undefined) await origins.clearWorkflow(id);
    else await origins.recordWorkflow(id, hookOrigin);
    return async () => {
      if (prior === undefined) await origins.clearWorkflow(id);
      else await origins.recordWorkflow(id, prior);
    };
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
    id?: string,
  ): Promise<WorkflowFileWriteResult> {
    const result = await serializedPerWorkflow(id, async () => {
      const restoreHookOrigin = await claimHookOrigin(type, id, context?.hookOrigin);
      if (id !== undefined) writingOrigins.add(id);
      try {
        return await work();
      } catch (error) {
        await restoreHookOrigin();
        throw error;
      } finally {
        if (id !== undefined) writingOrigins.delete(id);
      }
    });
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
   * Refuse, before any effect, a start whose trigger the engine could not take: one it cannot
   * encode, or one over its payload limit. `what` names the caller's part of it in the message.
   */
  function assertSendable(what: string, trigger: unknown): void {
    const limit = options.payloadMaximumBytes ?? null;
    let size: number;
    try {
      size = encode(trigger).byteLength;
    } catch (error) {
      throw options.createError(
        `The ${what} cannot be sent: ${error instanceof Error ? error.message : String(error)}`,
        'BAD_REQUEST',
      );
    }
    if (limit !== null && size > limit) {
      throw options.createError(
        `The ${what} is ${String(size)} bytes encoded, over the engine's ${String(limit)} byte limit.`,
        'BAD_REQUEST',
      );
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

  /**
   * Each revision with Weft's verdict against the file's current revision. A manifest is built
   * from a document by the pipeline registration runs, so it never calls a handler. A document
   * whose manifest cannot be built is reported through `diagnose` and its verdict is `null`; so is
   * every verdict when the workflow has no valid file to compare against.
   */
  async function withCompatibility(
    id: string,
    revisions: readonly WorkflowRevision[],
  ): Promise<readonly WorkflowRevisionReport[]> {
    const current = catalog.find(id);
    const manifestOf = async (document: WorkflowDocument) => {
      try {
        return await buildWorkflowDocumentManifest(toWeftDocument(document), host);
      } catch (error) {
        options.diagnose(`Could not build the manifest of a revision of workflow "${id}".`, error);
        return undefined;
      }
    };
    const currentManifest = current === undefined ? undefined : await manifestOf(current.document);
    return Promise.all(
      revisions.map(async (revision): Promise<WorkflowRevisionReport> => {
        if (current === undefined || currentManifest === undefined) {
          return { ...revision, compatibility: null };
        }
        if (revision.workflowVersion === current.version) {
          return { ...revision, compatibility: { compatible: true } };
        }
        const manifest = await manifestOf(revision.document);
        return {
          ...revision,
          compatibility:
            manifest === undefined ? null : checkWorkflowCompatibility(currentManifest, manifest),
        };
      }),
    );
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
      write('workflow.created', context, undefined, () => catalog.create(id, definition), id),
    update: (id, definition, update) =>
      write(
        'workflow.updated',
        update,
        update.expectedHash,
        () => catalog.update(id, definition, update),
        id,
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
      if (revisions.length > 0) return withCompatibility(id, revisions);
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
      try {
        const now = Date.now();
        // Two index-narrowed reads answer the counts. The engine intersects the type index with the
        // status or created-at index before it loads any state, so each read loads only the
        // instances it counts, and `limit: 1` bounds the reply.
        const [active, recent] = await Promise.all([
          engine.list({ type: id, status: [...IN_FLIGHT_STATUSES], limit: 1 }),
          engine.list({ type: id, createdAt: { gte: now - RECENT_RUN_WINDOW_MS }, limit: 1 }),
        ]);
        // The engine lists newest first, so the first item of a page is the newest in its window.
        // A workflow that ran today already has its newest instance; only a quiet one widens the
        // window, and an unfiltered read of its whole history is the last resort.
        let newest = recent.items[0];
        for (const windowMs of [QUIET_RUN_WINDOW_MS, undefined]) {
          if (newest !== undefined) break;
          const page = await engine.list({
            type: id,
            ...(windowMs === undefined ? {} : { createdAt: { gte: now - windowMs } }),
            limit: 1,
          });
          newest = page.items[0];
        }
        return {
          active: active.total,
          last24Hours: recent.total,
          lastRunAt: newest === undefined ? null : new Date(newest.createdAt).toISOString(),
        };
      } catch (error) {
        // A count the engine would not give is left out, never shown as zero, and never withholds
        // the workflow list it was asked for.
        options.diagnose(`Could not count the instances of workflow "${id}".`, error);
        return null;
      }
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
        finishReason: state.status === 'failed' ? finishReasonOf(state.errorStack) : null,
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
      const rejected: WorkflowSignalResult['rejected'] = [];
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
        // A payload the workflow's schema refuses starts nothing for that workflow, and says why.
        const issues =
          file.inputSchema === null ? [] : inputSchemaIssues(file.inputSchema, trigger.payload);
        if (issues.length > 0) {
          rejected.push({ id: file.id, issues });
          continue;
        }
        const handle = await engine.start(file.id, trigger);
        startedIds.push(handle.id);
      }
      return { started: startedIds, delivered, rejected };
    },

    async start(id, startOptions) {
      // The caller owns `startOptions` and its input: snapshot them before the first await.
      const { owner: starter, surface, idempotencyKey } = startOptions;
      const extraTags = [...(startOptions.tags ?? [])];
      const requested = startOptions.input ?? null;
      if (!z.json().safeParse(requested).success) {
        throw options.createError('The input must be a JSON value.', 'BAD_REQUEST');
      }
      const input: unknown = structuredClone(requested);
      workflows.assertStartable(id);
      if (applyPending) queueApply();
      await settled();
      if (applyFailure !== undefined) throw new WorkflowApplyError(applyFailure);
      // The apply may have changed the file: judge the input against the revision that will run.
      const file = catalog.find(id);
      if (file === undefined || file.paused) {
        throw options.createError(`Workflow "${id}" does not exist`, 'NOT_FOUND');
      }
      const issues = file.inputSchema === null ? [] : inputSchemaIssues(file.inputSchema, input);
      if (issues.length > 0) throw new WorkflowInputInvalidError(id, issues);
      const origin: TaskOrigin = {
        kind: 'person',
        principal: starter,
        surface: surface ?? 'api',
      };
      const trigger = { kind: 'manual', input, origin };
      assertSendable('input', trigger);
      const handle = await engine.start(id, trigger, {
        tags: [taskOriginTag(origin), ...extraTags],
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      // The revision the run is pinned to is the engine's to say: the catalog can already hold a
      // newer file than the one the engine registered (COR-1927). A run the engine cannot read
      // back is reported on the catalog's revision, the one it was started from.
      let pinned: string | undefined;
      try {
        const state = await engine.get(handle.id);
        pinned = state?.versionTuple.workflowVersion;
      } catch (error) {
        // The run exists: failing the call now would invite a retry that starts a second one.
        options.diagnose(
          `Could not read back the revision of started instance "${handle.id}" of workflow "${id}"; reporting the revision it was started from.`,
          error,
        );
      }
      return { runId: handle.id, workflow: id, workflowVersion: pinned ?? file.version };
    },

    async findStart(idempotencyKey) {
      const state = await engine.getByIdempotencyKey(idempotencyKey);
      if (state === null) return undefined;
      return {
        runId: state.id,
        workflow: state.type,
        workflowVersion: state.versionTuple.workflowVersion,
      };
    },

    getCode(id) {
      return registeredTypes.has(id) ? undefined : describeCodeWorkflow(engine, id);
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

    health: catalog.health,

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
