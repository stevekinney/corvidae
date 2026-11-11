/**
 * Child runs (COR-2376 slice S9): register a catalog run on the store, register the reviews of a
 * scheduled fire, admit and follow the task of a subordinate run, run one agent step of a workflow
 * file, and resolve the parent a child run belongs to. The wiring that builds the dispatcher, the
 * child topology and the peer call journal stays in `constructBureau`. Built by `constructBureau`
 * and reached only through `createBureau`; maintenance and the review announcements call into it.
 */
import { ANONYMOUS_LOCAL_OWNER, ownerOrLocal } from '../owner-of-record';
import {
  type ActiveRun,
  type AgentRun,
  type DurableRunDeps,
  isAgentRunWorkflowInput,
  runScopedExecutionContextOf,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import {
  type AgentStepRequest,
  type AgentStepResult,
  WorkflowAgentStepError,
} from '../workflow-host';
import { BUREAU_AGENT_NAME, detachBestEffortPromise } from '../bureau-construction-support';
import type { BureauChildChat } from '../child-topology-store';
import type { BureauCore } from './core';
import { BureauError } from '../bureau-errors';
import type { ChildTopologyParent } from '../child-topology';
import { DURABLE_FORCIBLY_TERMINABLE_STATUSES } from '../durable-run-waits';
import { type DurableEndReader, publishFreshCatalogRun } from '../catalog-run-settlement';
import { registerTrailingOnStep } from '../runtime-composition';
import { type ScheduledFireServicesNotice } from '../runtime-composition-types';
import { type SubordinateClaim, subordinateTaskAdmission } from '../catalog-task-settlement';
import type { SubordinateRun, WorkflowStepStart } from '../bureau-catalog-dispatch';
import type { WorkflowState } from '@lostgradient/weft';
import {
  agentStepResultFromRun,
  agentStepResultFromState,
  workflowStepRunId,
} from '../workflow-agent-step';
import { attachRunEventFeed } from '../run-event-feed-attachment.ts';
import { createScheduledFireApprovalHook } from '../approval-state-records';
import { findRunAgentName, serializeUnknownError } from '../serialization';
import { isTryAgentName } from '../agent-try';
import { originatingMessageText } from '../task-registry';
import { registerScheduledFireApproval } from '../scheduled-fire-review-state';
import { validateRunWorkspaceAuthority } from '../run-authority.ts';

/** The callables child runs reads from elsewhere in `constructBureau`. */
export interface ChildRunsPeers {
  /** The durable end of a catalog run. */
  readonly catalogDurableEnd: DurableEndReader;
  /** When a durable run was created. */
  readonly durableRunCreatedAt: (runId: string) => Promise<string | undefined>;
  /** Starts a workflow step run. */
  readonly startWorkflowStepRun: (start: WorkflowStepStart) => AgentRun<unknown, boolean>;
  /** The chat a parent run belongs to. */
  readonly chatOfParentRun: (parentRunId: string) => Promise<BureauChildChat | undefined>;
  /** The session id of a run this process holds. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Announces a review of a scheduled fire. */
  readonly announceFireReview: (
    runId: string,
    reviewId: string,
    kind: 'human-wait' | 'tool-approval',
    target: { signalName?: string; callId?: string },
  ) => Promise<void>;
  /** Follows the reviews of a scheduled fire. */
  readonly followFireReviews: (runId: string) => void;
  /** Waits for a durable run. */
  readonly waitForDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
}

/** Builds the child runs of one Bureau. Synchronous, and registers nothing. */
export function createChildRuns<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ChildRunsPeers,
) {
  const {
    options,
    workspace,
    runtimeServices,
    store,
    runEventFeeds,
    runtime,
    diagnose,
    catalogRunIds,
    runScopedContexts,
    runAttribution,
    runRequestContexts,
    scheduledFireReviewState,
  } = core;

  /**
   * COR-1302: registers the `ActiveRun` behind a `bureau.run()` dispatch on
   * `store` while it runs, so `getRun(run.id)`, `abortRun(run.id)`, and
   * `subscribeRunSnapshot` resolve the handle's id on both the direct and the
   * durable branch.
   * Before this runs, and for a catalog run that never builds an `ActiveRun`,
   * `getRun`/`abortRun` fall back to the unsettled handle (`findCatalogRun`).
   *
   * The run keeps everything else a catalog run had: no bureau session (its
   * session id reads `''`), no `activeRuns` entry (`catalogRuns` still drives
   * its shutdown), no listing, and no fan-out: its actions and its
   * registration and release stay off this bureau's event streams (see
   * `catalogRunIds` and the store subscription), so online evals, webhooks,
   * the audit trail, and durable event history see the runs they saw before.
   * Unlike a `createRun` run, it leaves `store` on its own once it settles;
   * see the release below.
   *
   * Its run event feed is attached before `store.register`, as
   * `createRunFromRequest` attaches one, and is disposed with the rest of the
   * run's per-run state when the run is released.
   *
   * A run recovered after a restart is not registered here: AB-240's recovery
   * path still hands it to the headless monitor in `onRecoveredWorkflow`.
   */
  function registerCatalogRun(activeRun: ActiveRun): void {
    const runId = activeRun.runId;
    if (store.getRun(runId)) return;
    catalogRunIds.add(runId);
    const detachRunEventFeed = attachRunEventFeed(runId, activeRun, runEventFeeds, {
      now: runtimeServices.clock.now,
      onError: (error, kind) => {
        diagnose({
          level: 'error',
          scope: 'event-feed',
          message: `[bureau] run event feed threw recording a "${kind}" event for run ${runId}:`,
          cause: error,
        });
      },
    });
    store.register(activeRun, runId);
    // Released once the run settles, as AB-22 releases its `catalogRuns`
    // entry, so a long-lived bureau does not keep one store entry per
    // historical `bureau.run()`. `removeRun`, not `deleteRun`: the run's
    // attribution stays, so `eventHistory`'s principal gate still resolves the
    // settled run for its owner (AB-241). Keyed to `result`, not `closed()`:
    // asking for `closed()` before the run settles would cost the handle's own
    // `closed()` its `not-required` fast path (AB-204). Registered here, ahead
    // of anything the returned handle chains onto `result`, so a caller that
    // has awaited `run.result()` already finds the run released.
    detachBestEffortPromise(
      activeRun.result.finally(() => {
        detachRunEventFeed();
        core.runHumanWaits.forget(runId);
        if (store.getRun(runId)?.activeRun === activeRun) store.removeRun(runId);
      }),
    );
  }

  /**
   * COR-1596 — registers a schedule fire's human waits and tool approvals as pending reviews,
   * live and recovered alike: the composition builds a fire's services the same way for a tick
   * and for a recovery, and hands them here before the fire takes a step.
   *
   * The human waits go through `runHumanWaits.attach`, the registration a recovered
   * `bureau.run()` run uses: neither has an `ActiveRun` on the store, and both are heard through
   * the emitter `attach` gives their services. The approvals go through the hook above.
   */
  async function registerScheduledFireReviews(
    fire: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ): Promise<void> {
    await core.runHumanWaits.attach(
      fire.runId,
      {
        agentName: fire.agentName,
        sessionId: fire.sessionId,
        announce: (reviewId, signalName) => {
          detachBestEffortPromise(
            peers
              .announceFireReview(fire.runId, reviewId, 'human-wait', { signalName })
              .then(() => core.tasks.announceChanged(fire.runId)),
          );
        },
      },
      services,
    );
    // COR-1621: a park the fire's checkpoint restored is a review held here, which a peer can
    // answer.
    if (core.runHumanWaits.holds(fire.runId)) peers.followFireReviews(fire.runId);
    // A fire's hook registry is built by `buildScheduledRunServices`; one that is missing would
    // leave the fire's approvals unlisted, so it is refused loudly, and the composition
    // diagnoses it.
    const hooks = services.options.hooks;
    if (hooks === undefined) {
      throw new Error(`Schedule fire "${fire.runId}" has no hook registry to list its approvals.`);
    }
    // COR-2298 — what the fire gives its tool calls, kept for the approved call that resumes later,
    // as a session run's is. Stored only once the fire holds an approval, so it is released with the
    // fire's other approval state (`endScheduledFireWhenNoApprovalRemains`).
    const fireScope = runScopedExecutionContextOf(services.options);
    // Registered after the merge `registerTrailingOnStep` documents avoiding (COR-1265), and
    // that is sound here: a fire's registry holds the Bureau's tier alone, so the merge's tier
    // offset is zero and the raw trailing priority lands exactly where a registration before the
    // merge would have put it. The hook only records in memory, so it needs no order against the
    // session write-back, which records the same approval durably.
    registerTrailingOnStep(
      hooks,
      'bureau:scheduled-fire-approvals',
      createScheduledFireApprovalHook(fire.runId, async (reviewId, approval, stepWasFinal) => {
        // A review the session records as decided stays decided across a replay that makes the
        // same call again (a decision made before the step committed): it is not listed.
        const session = await runtime.sessionStore?.load(fire.sessionId);
        const decided = session?.metadata['resolvedReviewIds'];
        if (Array.isArray(decided) && decided.includes(reviewId)) return;
        if (fireScope !== undefined) runScopedContexts.set(fire.runId, fireScope);
        registerScheduledFireApproval(
          scheduledFireReviewState,
          fire,
          services.toolbox,
          reviewId,
          approval,
          stepWasFinal,
        );
        await peers.announceFireReview(fire.runId, reviewId, 'tool-approval', {
          callId: approval.callId,
        });
        detachBestEffortPromise(core.tasks.announceChanged(fire.runId));
      }),
    );
  }

  /**
   * COR-1868 — admits the task of a child run, a goal attempt or a workflow step, from its claim.
   * Called once the run's start has committed, so no task is ever listed for a run that did not
   * exist. A second admission (a continued claim, a re-run activity) is a no-op: the record is
   * written once.
   */
  async function admitSubordinateTask(run: SubordinateRun): Promise<void> {
    let claim: SubordinateClaim;
    if (run.local !== undefined) {
      claim = {
        agentName: run.agentName,
        principal: run.local.principal,
        input: run.local.input,
        taskOrigin: run.local.taskOrigin,
      };
    } else {
      const loaded = await runtime.loadCatalogRunRecoveryRecord(run.runId);
      if (loaded.status !== 'found' || loaded.record.taskOrigin === undefined) return;
      claim = { ...loaded.record, taskOrigin: loaded.record.taskOrigin };
    }
    await core.tasks.recordAdmission(
      subordinateTaskAdmission(run.runId, claim, {
        ownerOf: ownerOrLocal,
        originatingMessage: originatingMessageText,
        createdAt: await peers.durableRunCreatedAt(run.runId),
      }),
    );
  }

  /**
   * COR-1868 — follows a subordinate run to its end. The task is admitted after the start
   * committed, then settled from the run's own end and from nothing else: the child topology, the
   * goal and the workflow keep their own settlements and never write the task.
   */
  function trackSubordinateRun(run: SubordinateRun): void {
    detachBestEffortPromise(
      run.started.then(
        (origin) => {
          // A claim written before COR-1868 holds no origin: the run stays a non-task.
          if (origin === undefined) return undefined;
          core.catalogSettlements.follow(
            publishFreshCatalogRun({
              handle: run.handle,
              agentName: run.agentName,
              admit: () => admitSubordinateTask(run),
              hook: core.catalogRunSettlements,
              followCleanup: (closed) => void core.tasks.watchCleanup(run.runId, closed),
              diagnose,
              durableEnd: peers.catalogDurableEnd,
              tracker: core.catalogSettlements,
            }),
          );
          return undefined;
        },
        // The start never committed, so there is no run and no task.
        () => undefined,
      ),
    );
  }

  /**
   * COR-1527 — runs one `agent` step of a workflow file: a standalone durable run of the named
   * agent as the deployment's owner, under an id that is a function of the instance and the step.
   * A step a restart re-executes finds that run already in the engine (the boot recovery is
   * resuming it) and waits for it instead of starting a second; only a step with no run yet
   * starts one.
   */
  /**
   * The recorded state of a step's agent run once it has ended. `waitForDurableRun` refuses to wait
   * under `maintenance: 'manual'`, where nothing re-reads the store between maintenance
   * passes for an outside caller. This caller is the engine's own activity: the run is driven by
   * this engine's recovery, and its handle settles when maintenance drives it.
   */
  async function awaitWorkflowStepRun(runId: string) {
    if (options.maintenance !== 'manual') return peers.waitForDurableRun(runId);
    const handle = runtime.durable?.engine.getHandle(runId);
    try {
      await handle?.result();
    } catch {
      // A run that failed or was cancelled rejects its result; its recorded state is read below.
    }
    return runtime.durable?.engine.get(runId);
  }

  async function runWorkflowAgentStep(request: AgentStepRequest): Promise<AgentStepResult> {
    const authority =
      workspace === undefined
        ? undefined
        : await validateRunWorkspaceAuthority(workspace, request.workspaceAuthority);
    if (workspace !== undefined && authority === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const owner = authority?.authorizingOwner ?? ANONYMOUS_LOCAL_OWNER;
    const engine = runtime.durable?.engine;
    if (engine === undefined) {
      throw new WorkflowAgentStepError(
        'agent-run-failed',
        request.agent,
        `Agent "${request.agent}" cannot run: this Bureau has no durable engine.`,
      );
    }
    const runId = workflowStepRunId(request.workflowId, request.stepAddress ?? request.step);
    if ((await engine.get(runId)) !== null) {
      // Adopt the run at this id only if it is this step's own: its recovery record carries the
      // step's marker. Anything else holding the id is not a run to take a result from.
      const claim = await runtime.loadCatalogRunRecoveryRecord(runId);
      if (
        claim.status !== 'found' ||
        claim.record.workflowStep?.workflowId !== request.workflowId ||
        claim.record.workflowStep.step !== request.step ||
        claim.record.workflowStep.stepAddress !== request.stepAddress ||
        claim.record.agentName !== request.agent ||
        claim.record.principal !== owner
      ) {
        throw new WorkflowAgentStepError(
          'agent-run-failed',
          request.agent,
          `The run id "${runId}" for step ${String(request.step)} of instance "${request.workflowId}" is held by another run, so the step cannot take a result from it.`,
        );
      }
      return agentStepResultFromState(request.agent, await awaitWorkflowStepRun(runId));
    }
    if (core.agentCatalog.find(request.agent) === undefined) {
      throw new WorkflowAgentStepError(
        'agent-not-found',
        request.agent,
        `Agent "${request.agent}" does not exist.`,
      );
    }
    let handle: ReturnType<typeof peers.startWorkflowStepRun>;
    try {
      handle = peers.startWorkflowStepRun({
        agentName: request.agent,
        input: request.message,
        runId,
        workflowStep: {
          workflowId: request.workflowId,
          step: request.step,
          ...(request.stepAddress === undefined ? {} : { stepAddress: request.stepAddress }),
        },
        principal: owner,
        ...(authority === undefined ? {} : { workspaceAuthority: authority }),
      });
    } catch (error) {
      throw new WorkflowAgentStepError(
        error instanceof BureauError && error.code === 'NOT_FOUND'
          ? 'agent-not-found'
          : 'agent-run-failed',
        request.agent,
        error instanceof Error ? error.message : String(error),
      );
    }
    return agentStepResultFromRun(request.agent, await handle.result());
  }

  /** COR-1670 — drops the peer call records of a run that was deleted; a failure only leaks them. */
  function releasePeerCalls(runId: string): void {
    detachBestEffortPromise(
      core.childTopologyStore.deletePeerCalls(runId).catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'child-topology',
          message: `[bureau] Could not remove the peer call records of run "${runId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }),
    );
  }

  /**
   * What Bureau knows about a run that wants to own a child: another child
   * (nested delegation), a `createRun` run, or a durable `bureau.run` run.
   * `undefined` for anything else — `children.dispatch` reports that as
   * `not-found`.
   */
  async function resolveChildParent(parentRunId: string): Promise<ChildTopologyParent | undefined> {
    const attribution = runAttribution.get(parentRunId);
    // COR-1911 — a run of a tried agent starts no child, whatever tool asks: it is answered as a
    // run that does not exist, as any parent that cannot own children is.
    if (isTryAgentName(attribution?.agentName ?? '')) return undefined;
    const childParent = await core.childTopologyStore.get(parentRunId);
    let inheritedAuthority =
      runRequestContexts.get(parentRunId)?.authority.workspace ?? childParent?.workspaceAuthority;
    if (workspace !== undefined && inheritedAuthority === undefined) {
      const recovered = await runtime.loadCatalogRunRecoveryRecord(parentRunId);
      if (recovered.status === 'found') inheritedAuthority = recovered.record.workspaceAuthority;
    }
    const workspaceAuthority =
      workspace === undefined
        ? undefined
        : await validateRunWorkspaceAuthority(workspace, inheritedAuthority);
    if (workspace !== undefined && workspaceAuthority === undefined) return undefined;

    if (childParent) {
      return {
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        agentName: childParent.childAgentName,
        principal: ownerOrLocal(childParent.principal),
        live: childParent.status === 'running',
      };
    }
    // A `bureau.run()` run on `store` (COR-1302) is resolved below as it was
    // before it was registered there: through its durable workflow, or not
    // at all when it is not durable and so cannot own children.
    const runState = catalogRunIds.has(parentRunId) ? undefined : store.getRun(parentRunId);
    if (runState) {
      return {
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        agentName: attribution?.agentName ?? findRunAgentName(runState) ?? BUREAU_AGENT_NAME,
        principal: ownerOrLocal(attribution?.principal),
        live: runState.status === 'running',
        ...contextOfParent(peers.getRunSessionIdentifier(runState)),
        ...(await chatStampOf(parentRunId)),
      };
    }
    const state = runtime.durable ? await runtime.durable.engine.get(parentRunId) : null;
    if (!state || !isAgentRunWorkflowInput(state.input)) return undefined;
    return {
      ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      agentName: state.input.agentName,
      principal: ownerOrLocal(attribution?.principal),
      live: DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status),
      ...contextOfParent(state.input.sessionId),
      ...(await chatStampOf(parentRunId)),
    };
  }

  /** {@link chatOfParentRun} as a field of a parent, absent for a run that belongs to no chat. */
  async function chatStampOf(parentRunId: string): Promise<{ readonly chat?: BureauChildChat }> {
    const chat = await peers.chatOfParentRun(parentRunId);
    return chat === undefined ? {} : { chat };
  }

  /** The parent's session, as a child's task origin records it; absent when the parent has none. */
  function contextOfParent(sessionId: unknown): { readonly contextId?: string } {
    return typeof sessionId === 'string' && sessionId !== '' ? { contextId: sessionId } : {};
  }

  /**
   * COR-772 — whether `runId` already names a run or workflow this bureau
   * knows other than through a child record. A child's identifier becomes
   * its durable run identifier, so `children.dispatch` refuses one of these
   * rather than let a caller take over that run's attribution, recovery
   * record, or place in the topology.
   */
  async function isKnownRun(runId: string): Promise<boolean> {
    if (runAttribution.has(runId) || store.getRun(runId) !== undefined) return true;
    if (!runtime.durable) return false;
    if ((await runtime.durable.engine.get(runId)) !== null) return true;
    return runtime.isCatalogRecoveredRun(runId);
  }

  return {
    registerCatalogRun,
    registerScheduledFireReviews,
    trackSubordinateRun,
    runWorkflowAgentStep,
    releasePeerCalls,
    resolveChildParent,
    isKnownRun,
  };
}
