/**
 * Task start (COR-2376 slice S2): `Bureau.tasks.start` and `Bureau.tasks.try`, the task handle's
 * abort, snapshot and settled result, and the tried-agent bookkeeping. Built by `constructBureau`
 * and reached only through `createBureau`. It and run creation call each other through `peers`.
 */
import type { AgentDefinitions } from '../agent-catalog';
import { type AgentFileDefinitionInput, AgentFileError } from '../agent-file';
import {
  type AgentRun,
  type AgentSession,
  type LivenessSnapshot,
  type RunEvent,
  type RunResult,
  SESSION_ORIGIN_METADATA_KEY,
  createAgentRun,
  readDurableRunResult,
} from '@lostgradient/operative';
import type { BureauCore } from './core';
import { BureauError, toBadRequest } from '../bureau-errors';
import type { ContextDeletionReport } from '../bureau-types/contexts';
import type { CreateRunRequest, RunDetail, RunSummary } from '../bureau-types/runs';
import type {
  StartTaskOptions,
  TaskHandle,
  TaskInput,
  TryAgentOptions,
  TryAgentResult,
} from '../bureau-types/tasks';
import type { CreatedRunSummary } from '../command-ledger';
import {
  type SessionTaskFields,
  snapshotStartOptions,
  taskRequestFieldsOf,
} from '../run-request-validation';
import { TRY_AGENT_NAME_START, tryToolProblem } from '../agent-try';
import type { TaskToolGrant } from '../task-registry';
import type { WorkflowState } from '@lostgradient/weft';
import { createTaskHandle, seedsConversation } from '../tasks/create-tasks';
import { isPlainAuthorityRecord } from '../session-authority';
import { ownerFromPrincipal } from '../owner-of-record';
import { serializeUnknownError } from '../serialization';

/** The callables task start reads from elsewhere in `constructBureau`. */
export interface TaskStartPeers {
  /** Creates a session run from a request, as `Bureau.createRun` does. */
  readonly createRunFromRequest: (
    request: CreateRunRequest & SessionTaskFields,
  ) => Promise<CreatedRunSummary>;
  /** Aborts a run and reports its summary, as `Bureau.abortRun` does. */
  readonly abortRun: (id: string, reason?: string) => RunSummary;
  /** Deletes a run and its record, as `Bureau.deleteRun` does. */
  readonly deleteRun: (id: string) => Promise<void>;
  /** The detail of a run this process holds, if any. */
  readonly getRun: (id: string) => RunDetail | undefined;
  /** Resolves once a run's durable workflow is terminal in the durable store. */
  readonly waitForDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
  /** Deletes a session and what it owns, as `Bureau.deleteSession` does. */
  readonly deleteSession: (
    id: string,
    deleteOptions?: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
    },
  ) => Promise<ContextDeletionReport>;
  /** Removes one run's durable workflow and its checkpoints. */
  readonly purgeDurableRun: (runId: string) => Promise<void>;
}

/** Builds the task start functions of one Bureau. Synchronous, and registers nothing. */
export function createTaskStart<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: TaskStartPeers,
) {
  const { runtimeServices, store, runtime, diagnose, toolGrantNow } = core;

  /**
   * Starts a task: a session run of `agentName` over `input`, in the context `options.contextId`
   * names or in a new one, returned as a {@link TaskHandle}. A fresh task's handle iterates its
   * run's events from the run's creation. A `commandId` retry that replays a task this process
   * runs iterates the live tail; one this process does not run iterates nothing, and its
   * `result()` settles from the durable store.
   */
  async function startTask(
    agentName: string,
    input: TaskInput,
    callerOptions: StartTaskOptions = {},
  ): Promise<TaskHandle> {
    const startOptions = snapshotStartOptions(callerOptions);
    if (typeof agentName !== 'string' || agentName.trim().length === 0) {
      toBadRequest('"agentName" must be a non-empty string');
    }
    const fields = taskRequestFieldsOf(input);
    if (seedsConversation(input) && startOptions.contextId !== undefined) {
      toBadRequest('A task seeded with a "conversation" creates its context: omit "contextId"');
    }
    let live: { run: AgentRun<unknown, true>; events: AsyncIterator<RunEvent> } | undefined;
    const created = await peers.createRunFromRequest({
      agentName,
      ...fields,
      ...(startOptions.contextId === undefined ? {} : { sessionId: startOptions.contextId }),
      ...(startOptions.principal === undefined ? {} : { principal: startOptions.principal }),
      ...(startOptions.commandId === undefined
        ? {}
        : { runCreationRequestId: startOptions.commandId }),
      ...(startOptions.requestContext === undefined
        ? {}
        : { requestContext: startOptions.requestContext }),
      ...(startOptions.traceContext === undefined
        ? {}
        : { traceContext: startOptions.traceContext }),
      ...(startOptions.withTraceContext === undefined
        ? {}
        : { withTraceContext: startOptions.withTraceContext }),
      ...(startOptions.origin === undefined ? {} : { origin: startOptions.origin }),
      ...(startOptions.signal === undefined ? {} : { signal: startOptions.signal }),
      taskInput: input,
      onActiveRun(activeRun) {
        const run = createAgentRun<unknown, true>(activeRun, {
          onCompletedIteration: 'empty',
          hasOutput: true,
        });
        live = { run, events: run[Symbol.asyncIterator]() };
      },
    });
    // A replay creates no run here: the handle follows the run this process holds, if any, and
    // the signal is bound to it here. A fresh run's signal was bound as the run was created.
    if (live === undefined) {
      const held = store.getRun(created.id)?.activeRun;
      if (held !== undefined) {
        const run = createAgentRun<unknown, true>(held, {
          onCompletedIteration: 'empty',
          hasOutput: true,
        });
        live = { run, events: run[Symbol.asyncIterator]() };
        if (startOptions.signal !== undefined) {
          bindStartSignal(startOptions.signal, created.id, held.result);
        }
      }
    }
    return createTaskHandle<unknown>({
      id: created.id,
      contextId: created.sessionId,
      receipt: created.receipt,
      live,
      settle: () => settledTaskResult(created.id),
      abort: (reason) => abortTask(created.id, reason),
      snapshot: () => taskSnapshot(created.id),
    });
  }

  /**
   * The refusal of a run of `agentName`, which no catalog agent resolves. A disabled plugin's agent
   * is listed `unavailable` (COR-2009), so the refusal says why it cannot run.
   */
  function missingAgentError(agentName: string): BureauError {
    const unavailable = core.agentCatalog
      .list()
      .find((listing) => listing.id === agentName)?.unavailable;
    return new BureauError(
      unavailable === undefined
        ? `Unknown agent "${agentName}"`
        : `Agent "${agentName}" is unavailable: ${unavailable.message}.`,
      'NOT_FOUND',
    );
  }

  /**
   * COR-1911 — a tried agent belongs to the one context that was started with it: a name that is
   * held for another context, or for none, is an agent that does not exist.
   */
  function assertTriedAgentBelongsTo(agentName: string, sessionId: string): void {
    if (core.tryAgents.contextOf(agentName) !== sessionId) {
      throw new BureauError(`Unknown agent "${agentName}"`, 'NOT_FOUND');
    }
  }

  /** COR-1911 — the origin a tried context records once, when its session is created. */
  function triedOriginMetadata(
    triedRun: boolean,
    session: AgentSession | undefined,
  ): Record<string, string> {
    return triedRun && session === undefined ? { [SESSION_ORIGIN_METADATA_KEY]: 'try' } : {};
  }

  /**
   * COR-1710, COR-1911 — the tools a task starting now is granted: the settings', less
   * `scheduleWakeup` and `decide` for a tried agent, whatever the settings offer. The admission
   * record keeps the grant, so the task's recovery offers the same tools.
   */
  function toolGrantFor(triedRun: boolean): TaskToolGrant {
    return triedRun ? { ...toolGrantNow(), wakeup: false, decide: false } : toolGrantNow();
  }

  /**
   * COR-1911 — removes the runs of a tried context that has been deleted: each run's task record,
   * its place in the run store, its durable workflow and its checkpoints. A context a person chats
   * in keeps these as history until retention ends them; a tried one is a throwaway, so it keeps
   * none. Best-effort for each step, like the rest of a deletion that has already committed: a
   * failure is diagnosed and the retention that ends every run's history ends this one's.
   * The content a deletion of any context leaves (event history, dedupe and surface markers,
   * audit text) is purged by `chatContentPurge` (COR-1934), which this tried path runs after; the
   * engine's tombstones (`wf-gen:` and `wf-owner-epoch:`), which keep a run id from being reused,
   * stay until retention.
   */
  async function discardTriedRuns(
    session: AgentSession,
    knownRunIds: ReadonlySet<string>,
  ): Promise<void> {
    const runIds = new Set(knownRunIds);
    const owners = session.metadata['lastRunOwningPrincipals'];
    if (isPlainAuthorityRecord(owners)) for (const runId of Object.keys(owners)) runIds.add(runId);
    // The run store holds only this process's runs, and the ownership map is pruned once a run's
    // event history expires, while its task record stays longer: the durable context index is
    // the complete list of the context's tasks.
    try {
      for (const taskId of await core.tasks.taskIdsOfContext(session.id, session.incarnation)) {
        runIds.add(taskId);
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'agent-try',
        message: `[bureau] Could not list the tasks of a deleted tried context "${session.id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
    const attempt = async (what: string, runId: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'agent-try',
          message: `[bureau] Could not remove the ${what} of run "${runId}" of a deleted tried context "${session.id}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    };
    for (const runId of runIds) {
      if (store.getRun(runId) !== undefined)
        await attempt('run', runId, () => peers.deleteRun(runId));
      await attempt('task record', runId, () => core.tasks.remove(runId));
      if (runtime.durable === undefined) continue;
      await attempt('workflow and checkpoints', runId, () => peers.purgeDurableRun(runId));
    }
  }

  /**
   * COR-1911 — builds an agent from `definition` as an agent file would be, writes nothing, and
   * starts a new context with it over `input`. The agent is held in memory for that context alone
   * and dropped with it; see `agent-try.ts` for what a run of it may not do.
   */
  async function tryAgent(
    definition: AgentFileDefinitionInput,
    input: TaskInput,
    tryOptions: TryAgentOptions = {},
  ): Promise<TryAgentResult> {
    core.assertRunAdmissionOpen('run');
    const owner = ownerFromPrincipal(tryOptions.principal, toBadRequest);
    if (core.fileAgents === undefined) {
      throw new AgentFileError(
        'agent-directory-not-configured',
        'This Bureau has no agent source or no models.generate, so it cannot build an agent to try.',
      );
    }
    const refused = tryToolProblem(definition);
    if (refused !== undefined) throw new AgentFileError(refused.code, refused.message, refused);
    const contextId = runtimeServices.identifiers.next('session');
    const agentName = `${TRY_AGENT_NAME_START}${runtimeServices.identifiers.next('try')}`;
    // Built before it is held: a definition that would not load as a file is refused here with the
    // file's own field-named problem, and nothing exists.
    const agent = core.fileAgents.files.ephemeral(agentName, definition);
    core.tryAgents.hold({ name: agentName, agent, definition, owner, contextId });
    try {
      const handle = await startTask(agentName, input, {
        contextId,
        principal: owner,
        origin: { kind: 'chat' },
        ...(tryOptions.requestContext === undefined
          ? {}
          : { requestContext: tryOptions.requestContext }),
        ...(tryOptions.signal === undefined ? {} : { signal: tryOptions.signal }),
      });
      return { contextId, agentName, taskId: handle.id };
    } catch (error) {
      // A start that failed may have saved the context before it did: take both away.
      try {
        await peers.deleteSession(contextId);
      } catch (cleanupError) {
        diagnose({
          level: 'error',
          scope: 'agent-try',
          message: `[bureau] A tried agent failed to start, and its context "${contextId}" could not be removed: ${serializeUnknownError(cleanupError)}`,
          cause: cleanupError,
        });
      }
      core.tryAgents.release(agentName, contextId);
      throw error;
    }
  }

  /**
   * Binds a task's start signal to the run this process holds under `id`: an aborted signal
   * aborts it now, a later abort when it fires. Once the run settles the signal has nothing left
   * to abort, so the listener goes with it, and a long-lived caller signal does not collect one
   * per task.
   */
  function bindStartSignal(signal: AbortSignal, id: string, settled: Promise<unknown>): void {
    const onAbort = () => abortTask(id, 'Aborted by the start signal');
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const removeListener = () => signal.removeEventListener('abort', onAbort);
    void settled.then(removeListener, removeListener);
  }

  /**
   * Requests cancellation of a task through `abortRun`, so the abort is tracked as every other
   * one is (`internals.abortingTasks()`). Does nothing once the task has settled or for a task
   * this process does not hold. The reason reaches the run's abort signal and its children's
   * parent-cancellation reason.
   */
  function abortTask(id: string, reason?: string): void {
    if (store.getRun(id)?.status !== 'running') return;
    peers.abortRun(id, reason);
  }

  /**
   * A task's liveness now, from the run this process holds. A task this process does not hold
   * (a replay of a task another process ran) is `NOT_FOUND`.
   */
  function taskSnapshot(id: string): LivenessSnapshot {
    const detail = peers.getRun(id);
    if (detail !== undefined) return detail.liveness;
    throw new BureauError(`Task "${id}" is not held by this process`, 'NOT_FOUND');
  }

  /**
   * The result of a task this process does not run, once its workflow is terminal in the durable
   * store: the full `RunResult`, rebuilt from the workflow's summary and the run's checkpoint as
   * every other durable reader does, since the workflow records only a summary (a step count, no
   * usage or conversation). A task that did not complete rejects with its error.
   */
  async function settledTaskResult(id: string): Promise<RunResult> {
    const state = await peers.waitForDurableRun(id);
    if (state === undefined || runtime.durable === undefined) {
      throw new BureauError('Task results need a durable engine', 'NOT_CONFIGURED', 'durable');
    }
    if (state === null) throw new BureauError(`Task "${id}" not found`, 'NOT_FOUND');
    if (state.status !== 'completed') {
      throw new BureauError(
        `Task "${id}" ended ${state.status}${state.error === undefined ? '' : `: ${state.error}`}`,
        'CONFLICT',
      );
    }
    const reading = await readDurableRunResult(runtime.durable, id, { runtime: runtimeServices });
    if (reading.status !== 'completed') {
      throw new BureauError(`Task "${id}" result cannot be read (${reading.status})`, 'CONFLICT');
    }
    return reading.result;
  }

  return {
    startTask,
    missingAgentError,
    assertTriedAgentBelongsTo,
    triedOriginMetadata,
    toolGrantFor,
    discardTriedRuns,
    tryAgent,
    bindStartSignal,
    abortTask,
  };
}
