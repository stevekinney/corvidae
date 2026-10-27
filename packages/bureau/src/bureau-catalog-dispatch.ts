import {
  CompletableEventTarget,
  mergeHookRegistries,
  type RuntimeServices,
} from '@lostgradient/lifecycle';
import type {
  ActiveRun,
  CombinedOperativeEventMap,
  DurableRunDeps,
  AgentInput,
  AgentRun,
  AgentRunContext,
  ClosedOptions,
  DefinitionResolvingAgentWithResolver,
  RunnableAgent,
  RunOptions,
} from '@lostgradient/operative';
import {
  AgentContractError,
  createActiveRun,
  createAgentRun,
  createDeferredAgentRun,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  readGenerationProfile,
  resolvesOwnGuardrails,
} from '@lostgradient/operative';

import type { AgentDefinitions, AnyRunnableAgent, BureauAgentCatalog } from './agent-catalog';
import type { FileAgentRuntime } from './agent-file-runtime';
import type { SettledCatalogHandle } from './catalog-run-asset-release';
import type { ChildTopologyStart } from './child-topology';
import {
  type GoalAttemptCostEstimation,
  isGoalAttemptCostEstimation,
} from './goal-cost-estimation';
import { ownerOrLocal } from './owner-of-record';
import {
  type RuntimeComposition,
  unsetMediaOptions,
  wireDurableOptInTools,
} from './runtime-composition';
import type { RunAttribution } from './serialization';
import { humanInputEnabled, humanInputSchemasOf } from './human-input-option';
import type { BureauHumanInputOption, BureauRunOptions } from './types';

type CatalogRunErrorCode = 'CONFLICT' | 'NOT_FOUND';

/**
 * COR-1630 — a catalog run's handle settled. Not necessarily an end: a handle also settles for a
 * run cut short by disposing the engine, which resumes at the next boot, so whether to let go of
 * the run's asset claims is the receiver's to decide (`catalog-run-asset-release.ts`).
 */
export interface CatalogRunEnded {
  readonly runId: string;
  /** The principal the run was dispatched for, as given; the run's claims were taken as its owner. */
  readonly principal: string | undefined;
  readonly settled: SettledCatalogHandle;
}

export interface CatalogDispatcherDependencies {
  readonly agentCatalog: Pick<BureauAgentCatalog<AgentDefinitions>, 'find'>;
  readonly runtime: RuntimeComposition;
  readonly runtimeServices: RuntimeServices;
  readonly getShutdownPromise: () => Promise<unknown> | undefined;
  readonly catalogRuns: Set<AgentRun<unknown, boolean>>;
  readonly runAttribution: Map<string, RunAttribution>;
  readonly detachBestEffortPromise: (promise: Promise<unknown>) => void;
  readonly createBureauError: (message: string, code: CatalogRunErrorCode) => Error;
  readonly validateAgentRunInput: (input: unknown) => void;
  /**
   * COR-772 — called once a durable catalog run settles as aborted, however
   * the abort arrived (its own handle, `dispose`, or the engine cancelling
   * it), so Bureau can apply that run's children's parent-cancellation
   * policy exactly as boot recovery would for the same cancelled workflow.
   */
  readonly onDurableRunAborted: (runId: string, reason: string) => void;
  /**
   * COR-1302 — called with the `ActiveRun` behind a `bureau.run()` dispatch
   * the moment it exists, on both the durable and the direct branch, so
   * Bureau can register it on its run store and `getRun`/`abortRun` accept
   * the handle's `id`. Child runs and goal attempts are not passed: each is
   * owned and controlled through its own surface (`children`, `goals`). A
   * hand-written catalog agent with no definition resolver builds its run
   * inside its own `run()`, so there is no `ActiveRun` to pass for it.
   */
  readonly registerCatalogRun?: ((activeRun: ActiveRun) => void) | undefined;
  /**
   * COR-1630 — called once when the handle of a catalog run settles, for every dispatch that holds
   * its own asset claims and is not a goal attempt: `bureau.run()`, a child run and a workflow
   * step, durable or not. A goal attempt is left to the goal forwarder, which hands its rows to
   * the goal's session before it releases them. A run recovered after a restart has no handle
   * here; the settlement hook covers it. Must not reject.
   */
  readonly onCatalogRunEnded?: ((ended: CatalogRunEnded) => void | Promise<void>) | undefined;
  /**
   * COR-1577, COR-1700 — `BureauOptions.humanInput`: `requestHumanInput` is offered to a durable
   * `bureau.run()` run unless this is `false`, which the caller also passes for a non-durable
   * Bureau. Not to a child or a goal attempt, whose park nothing would be listening for.
   */
  readonly humanInput?: BureauHumanInputOption | undefined;
  /**
   * COR-1524 — what a run of a file-based agent needs: its snapshot recorded before it starts,
   * and its reference settled when it ends. Absent when the Bureau has no agent directory.
   */
  readonly fileAgents?:
    | Pick<
        FileAgentRuntime,
        'agentForRecordedRun' | 'beginRunStart' | 'recordRunStart' | 'releaseRun' | 'settleRun'
      >
    | undefined;
}

/**
 * COR-1367 — the guardrail half of a catalog run's `AgentRunContext`.
 *
 * An agent that resolves its own guardrails (`createAgent`, marked by
 * `OPERATIVE_RESOLVES_GUARDRAILS`) applies them itself: its own `guardrails`
 * declaration, else the AB-40 preset. Bureau then registers no guardrail
 * invariant for the run (`createBureauInvariantHooks(…, { agentResolvesGuardrails: true })`),
 * so the policy runs exactly once.
 *
 * Any other agent — a hand-written `RunnableAgent`, or a `createLazyAgent`
 * wrapper whose underlying agent is unknown until it loads — has no policy of
 * its own to resolve, and the context carries `false` so a `createAgent` behind a
 * lazy wrapper does not add the preset a second time underneath it. Such an inner
 * agent's own explicit declaration still runs.
 */
export function catalogRunGuardrailsContext(
  agent: object,
): Pick<AgentRunContext, 'inheritedGuardrails'> {
  return resolvesOwnGuardrails(agent) ? {} : { inheritedGuardrails: false };
}

/**
 * COR-851 — one goal attempt: a durable catalog run under the attempt's
 * deterministic run id, started by Bureau's goal port.
 */
export interface GoalAttemptStart {
  readonly agentName: string;
  /** The first attempt's prompt, or a later attempt's seed conversation with its turn appended. */
  readonly input: AgentInput;
  readonly runId: string;
  /** Recorded with the run, so the goal can later tell its own run from another at the same id. */
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly principal?: string | undefined;
}

/**
 * A goal attempt's run, and the moment its engine workflow is durably there.
 * The run handle is deferred: its agent resolution, recovery-record write, and
 * engine start all happen after it is returned. `durablyStarted` settles when
 * they have, and rejects with whatever stopped them, so a caller can tell
 * "the run exists" from "a start is under way".
 */
/**
 * The persistable selection for a run's `costEstimation`: copied as plain JSON
 * and checked with the decoder's own predicate, so a value the recovery record
 * would be refused on read is never written.
 */
function goalAttemptCostEstimation(
  costEstimation: GoalAttemptCostEstimation | undefined,
): GoalAttemptCostEstimation {
  let selection: unknown;
  try {
    selection = costEstimation === undefined ? null : JSON.parse(JSON.stringify(costEstimation));
  } catch (error) {
    // A cycle, a bigint, or a throwing `toJSON`: the agent resolves the same
    // way on every try, so this is the agent's property, not a transient fault.
    throw new GoalAttemptInvalidCostEstimationError(
      `The agent declared a cost estimation that cannot be persisted as plain JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isGoalAttemptCostEstimation(selection)) {
    throw new GoalAttemptInvalidCostEstimationError(
      'The agent declared a cost estimation that cannot be persisted as plain JSON.',
    );
  }
  return selection;
}

/**
 * COR-1527 — one `agent` step of a workflow file: a standalone durable run of the named agent under
 * a run id that is a function of the workflow instance and the step, so a step that a restart
 * re-executes finds its own run instead of starting a second.
 */
export interface WorkflowStepStart {
  readonly agentName: string;
  /** The step's message, with the instance's trigger and previous result appended. */
  readonly input: string;
  readonly runId: string;
  /** Recorded with the run, so the step can later tell its own run from another at the same id. */
  readonly workflowStep: WorkflowStepOwner;
  readonly principal?: string | undefined;
}

/** Which workflow step a run was started for; see `CatalogRunRecoveryRecord.workflowStep`. */
export interface WorkflowStepOwner {
  readonly workflowId: string;
  readonly step: number;
}

/** Which goal attempt a run was started for; see `CatalogRunRecoveryRecord.goalAttempt`. */
interface GoalAttemptOwner {
  readonly goalRunId: string;
  readonly attemptIndex: number;
}

/**
 * COR-851 — a goal attempt cannot run because of a permanent property of its
 * agent, not a transient fault. The attempt ends with this reason instead of
 * failing an activity that would retry the same refusal forever.
 */
export class GoalAttemptNotDurableCapableError extends Error {
  readonly reason = 'agent-not-durable-capable';
  constructor(message: string) {
    super(message);
    this.name = 'GoalAttemptNotDurableCapableError';
  }
}

/**
 * COR-851 — a goal attempt's agent declared a cost estimator that cannot be
 * persisted as plain JSON (a cycle, a bigint, a throwing `toJSON`, fields the
 * decoder does not know, or an invalid price). The agent resolves the same way
 * on every try, so the attempt ends with this reason instead of failing an
 * activity that would retry the same refusal forever.
 */
export class GoalAttemptInvalidCostEstimationError extends Error {
  readonly reason = 'invalid-cost-estimation';
  constructor(message: string) {
    super(message);
    this.name = 'GoalAttemptInvalidCostEstimationError';
  }
}

/**
 * COR-851 — the attempt's claim is tombstoned: the goal ended, closed, or was
 * canceled over this attempt while its start was between claiming the run and
 * creating it. Nothing is started from a tombstoned claim, and the attempt
 * stands down; it is neither a fault to retry nor a verdict on the attempt.
 */
export class GoalAttemptTombstonedError extends Error {
  constructor(runId: string) {
    super(`The claim for run "${runId}" is tombstoned: the goal ended over this attempt.`);
    this.name = 'GoalAttemptTombstonedError';
  }
}

export interface GoalAttemptRun {
  readonly run: AgentRun<unknown, boolean>;
  readonly durablyStarted: Promise<void>;
}

export function createCatalogDispatcher({
  agentCatalog,
  runtime,
  runtimeServices,
  getShutdownPromise,
  catalogRuns,
  runAttribution,
  detachBestEffortPromise,
  createBureauError,
  validateAgentRunInput,
  onDurableRunAborted,
  humanInput,
  registerCatalogRun,
  onCatalogRunEnded,
  fileAgents,
}: CatalogDispatcherDependencies): {
  planChildRun: (
    name: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  startChildRun: (start: ChildTopologyStart) => AgentRun<unknown, boolean>;
  startGoalAttemptRun: (start: GoalAttemptStart) => GoalAttemptRun;
  startWorkflowStepRun: (start: WorkflowStepStart) => AgentRun<unknown, boolean>;
} {
  /**
   * The goal attempt each attribution entry this dispatcher made for one stands
   * for. Keyed by the entry itself, so it lives and dies with it and an entry
   * set anywhere else (a recovery reseed, an ordinary run) is never mistaken for
   * a goal attempt's.
   */
  const goalAttemptAttributions = new WeakMap<RunAttribution, GoalAttemptOwner>();
  /** The workflow step each attribution entry this dispatcher made for one stands for. */
  const workflowStepAttributions = new WeakMap<RunAttribution, WorkflowStepOwner>();
  /**
   * How many live executions of a goal attempt hold each attribution object. A
   * same-attempt retry reuses the held object instead of replacing it, so an
   * older execution's failure must not delete what the retry still relies on:
   * the entry goes only when its last holder lets go.
   */
  const attributionHolders = new WeakMap<RunAttribution, number>();

  /**
   * COR-1630 — tells Bureau when `handle` settles, so it can release the claims the run's rows
   * hold. A foreign agent's result that carries no conversation is reported as a rejection: there
   * is nothing to read the run's rows from.
   */
  function reportWhenSettled(
    handle: AgentRun<unknown, boolean>,
    runId: string | undefined,
    principal: string | undefined,
  ): AgentRun<unknown, boolean> {
    if (onCatalogRunEnded === undefined || runId === undefined) return handle;
    detachBestEffortPromise(
      handle.result().then(
        (result) =>
          onCatalogRunEnded({
            runId,
            principal,
            settled:
              typeof result.conversation?.getMessages === 'function'
                ? {
                    kind: 'result',
                    finishReason: result.finishReason,
                    conversation: result.conversation,
                  }
                : { kind: 'rejected' },
          }),
        () => onCatalogRunEnded({ runId, principal, settled: { kind: 'rejected' } }),
      ),
    );
    return handle;
  }

  function trackCatalogRun(handle: AgentRun<unknown, boolean>): AgentRun<unknown, boolean> {
    catalogRuns.add(handle);
    // `detachBestEffortPromise`, not a bare `void ... .finally(...)`: AB-15's
    // contract says a well-behaved `RunnableAgent.result()` never rejects
    // (it settles through `RunResult.error` instead), but "JavaScript
    // callers" is itself one of this issue's acceptance-criteria categories
    // — a foreign, non-conforming agent's `result()` genuinely can reject,
    // and a dropped rejection under `void` would be an unhandled rejection
    // that is this bureau's fault, not the caller's.
    detachBestEffortPromise(
      handle.result().finally(() => {
        catalogRuns.delete(handle);
      }),
    );
    return handle;
  }

  function runDurableCatalogAgent(
    name: string,
    input: AgentInput,
    runOptions: BureauRunOptions | undefined,
    context: AgentRunContext,
    principal: string | undefined,
    agent: AnyRunnableAgent & DefinitionResolvingAgentWithResolver,
    /**
     * COR-772 — a child dispatch supplies its own stable run id, recorded in
     * Bureau's topology before this starts, so the durable workflow's id is
     * the child's id and recovery can find it by that id alone. Unlike a
     * minted id, its caller chose it, so it claims its attribution and
     * recovery record only where no other run already holds them.
     */
    runIdOverride?: string,
    /**
     * COR-851 — a goal attempt's id and recovery record are a deterministic
     * function of the goal, so a claim already holding this id is the same
     * attempt's own claim from a start that died before the workflow existed.
     * The record is rewritten with identical content and the start continues
     * from it, rather than refusing as a child with a taken id would.
     */
    goalAttempt?: GoalAttemptOwner,
    /** COR-851 — settled with the durable start's own outcome; see {@link GoalAttemptRun}. */
    durableStart?: {
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    },
    /**
     * COR-1527 — an `agent` step of a workflow file. Like a goal attempt, its id is a function
     * of what started it, so a claim already holding this id is the same step's own claim from a
     * start that died before the workflow existed; and like one, its run is not a task and is
     * left to the engine's disposal at shutdown rather than aborted.
     */
    workflowStep?: WorkflowStepOwner,
  ): AgentRun<unknown, boolean> {
    const durable = runtime.durable;
    if (!durable) {
      throw createBureauError('Durable runtime unavailable', 'CONFLICT');
    }
    const runId = runIdOverride ?? runtimeServices.identifiers.next('agent-run');
    // COR-1302 — the handle returned below exists before the durable run does,
    // so it takes this id now: `createDeferredAgentRun` reports it as the
    // handle's `id` and liveness `snapshot().id`, and the resolved run adopts
    // it, so the handle, the workflow, and its event history share one id.
    context.runId = runId;
    if (runIdOverride !== undefined) {
      const held = runAttribution.get(runId);
      // An attribution already under this id is another run's, unless it is this
      // very goal attempt's own from an earlier execution of the same start (a
      // resolver that outlived the start timeout inserted it before Weft retried
      // the activity). Verified by what this dispatcher recorded when it set the
      // entry: the same goal and attempt, and the same agent and principal. Any
      // other holder, and an entry nothing here recorded, still conflicts.
      const sameAttempt =
        held !== undefined &&
        ((goalAttempt !== undefined &&
          goalAttemptAttributions.get(held)?.goalRunId === goalAttempt.goalRunId &&
          goalAttemptAttributions.get(held)?.attemptIndex === goalAttempt.attemptIndex) ||
          (workflowStep !== undefined &&
            workflowStepAttributions.get(held)?.workflowId === workflowStep.workflowId &&
            workflowStepAttributions.get(held)?.step === workflowStep.step)) &&
        held.agentName === name &&
        held.principal === ownerOrLocal(principal);
      if (held !== undefined && !sameAttempt) {
        throw createBureauError(`Run "${runId}" already exists`, 'CONFLICT');
      }
    }
    // AB-241 — recorded BEFORE any async work, mirroring
    // `createRunFromRequest`'s own `runAttribution.set` (it writes before
    // `store.register` so it's in place before any observer can see this
    // run). Review finding: cleaned up ONLY when this minted `runId` is
    // abandoned before it ever actually dispatches — the `AgentContractError`
    // fallback and the non-`AgentContractError` resolver-failure catch
    // below, both because an attribution entry keyed to a run that never
    // existed would otherwise be a permanent phantom. A run that DOES
    // dispatch and settle keeps its attribution indefinitely (see
    // `trackCatalogRun`'s own doc comment) — it is not cleaned up here.
    const retained = runIdOverride === undefined ? undefined : runAttribution.get(runId);
    let ownAttribution: RunAttribution;
    if (retained !== undefined) {
      // The same attempt's retry (any other holder threw above): it takes a
      // share of the held object rather than replacing it.
      ownAttribution = retained;
    } else {
      // COR-718: every run has an owner, so a dispatch with no principal is
      // owned by `anonymous:local` rather than left without an attribution.
      ownAttribution = { agentName: name, principal: ownerOrLocal(principal) };
      runAttribution.set(runId, ownAttribution);
      if (goalAttempt !== undefined) goalAttemptAttributions.set(ownAttribution, goalAttempt);
      if (workflowStep !== undefined) workflowStepAttributions.set(ownAttribution, workflowStep);
    }
    attributionHolders.set(ownAttribution, (attributionHolders.get(ownAttribution) ?? 0) + 1);
    // Lets go of this execution's share, once. The entry is deleted only when
    // the map still holds the very object this execution holds and no other
    // execution of the attempt does.
    let attributionReleased = false;
    const releaseAttribution = (): void => {
      if (attributionReleased) return;
      attributionReleased = true;
      const remaining = (attributionHolders.get(ownAttribution) ?? 1) - 1;
      attributionHolders.set(ownAttribution, remaining);
      if (remaining <= 0 && runAttribution.get(runId) === ownAttribution) {
        runAttribution.delete(runId);
      }
    };
    // Captured so the wrapper below can forward an abort straight to the
    // dispatched durable `ActiveRun` even in the race `createDeferredAgentRun`
    // does not close: `resolveDurableAgent` unconditionally starts the
    // durable engine dispatch (it has no way to observe the outer handle's
    // already-terminal state — `createDeferredAgentRun` checks that only
    // AFTER awaiting this resolver, and only to decide whether to call the
    // synthetic agent's `run()`, not whether to have started it). A caller
    // that calls `.abort()` on the returned handle before this resolver's
    // `await resolver(...)` settles would otherwise leave the already-started
    // durable workflow running, unobserved, forever.
    let dispatchedActiveRun: ActiveRun | undefined;
    // Review round 2 (Codex): the previous fix only forwarded abort() to
    // `dispatchedActiveRun` when it ALREADY existed at the moment abort()
    // ran — it did nothing when abort() was called (or the handle
    // disposed) while `resolver(input, context)` was still pending, since
    // `dispatchedActiveRun` is undefined for that entire window and
    // nothing re-checks after it's finally assigned. Remember the request
    // instead, and act on it the instant the ActiveRun exists, whichever
    // order the two events happen in.
    let cancellationRequested: { reason: string | undefined; dispose: boolean } | undefined;
    // AB-291 (AC4): the durable `ActiveRun`'s own `closed()` acknowledgement
    // for a cancellation FORWARDED here (below, once `dispatchedActiveRun`
    // exists) — set the instant that forward runs. `guardedRun.closed()`
    // (below `deferredRun`) must await this, not `deferredRun.closed()`
    // alone: `createDeferredAgentRun`'s own abort handling settles its
    // synthetic `result()` — and therefore its `closed()` — IMMEDIATELY
    // when `abort()` arrives before its resolver has settled (the shared
    // async work is deliberately left running in the background,
    // uncancelled, matching `createLazyAgent`'s module-load precedent).
    // Left alone, `guardedRun.closed()` would report `completed` before
    // the durable engine dispatch this forward targets has even started,
    // let alone been cleaned up.
    // Typed off `ActiveRun['closed']`'s own return, not this file's
    // locally-imported `CleanupAcknowledgement` (bureau's distinct
    // `BureauShutdownReport` string-status vocabulary, shadowing
    // operative's `{ status, reason?, error? }` object shape that
    // `ActiveRun.closed()` actually returns).
    let cancellationForward: ReturnType<ActiveRun['closed']> | undefined;
    // Resolves once `resolveDurableAgent` itself has settled (success,
    // fallback, or throw) — i.e. once `cancellationForward` above has its
    // final value (set or not). `guardedRun.closed()` gates on this before
    // reading `cancellationForward`, so it never reads it too early.
    let dispatchSettled: (() => void) | undefined;
    const dispatchSettledPromise = new Promise<void>((resolve) => {
      dispatchSettled = resolve;
    });
    // `createDeferredAgentRun` resolves a `RunnableAgent` then calls its
    // `run()` — built for `createLazyAgent`'s "resolve a module" case, but
    // agnostic to WHY resolution is async. Wrapping the durable-engine
    // handle (already fully built by the time this resolver settles) in a
    // one-shot synthetic agent reuses its buffering/abort-forwarding
    // machinery instead of reimplementing it.
    /**
     * AB-260: a catalog agent's own resolver builds its RunOptions independently
     * of `runtime.createRunRuntime` (AB-240's dispatch path), so without this it
     * would fall back to operative's OWN default RuntimeServices rather than this
     * bureau's composed instance — breaking "two bureaus in one process never
     * share a clock" for catalog-dispatched runs. Never overrides a resolver that
     * deliberately set its own `runtime`.
     *
     * COR-1265 criterion 3b. The agent's own tier is already inside
     * `resolvedOptions.hooks`, from its own `buildRunOptions`. Bureau's
     * invariants — identity and both guardrails, the registrations that close
     * over nothing run-specific — go in front of it, so a durably dispatched
     * catalog run is governed by the same policy every other dispatch shape is.
     * AB-240's separation is untouched: this adds a hook tier, not a provider, a
     * toolbox or a generate.
     */
    // COR-1367 — read once: the agent applies its own guardrails, so Bureau's
    // tier carries none for it (see `inheritedGuardrailsContext`).
    const agentResolvesGuardrails = resolvesOwnGuardrails(agent);
    // COR-1577 — `requestHumanInput` on a `bureau.run()` run, wired as the session path wires it:
    // the tool parks the workflow through the run's own `ctx.services`, captured by `onServices`
    // as the engine starts it, and announces the park on the emitter the run's `ActiveRun` uses.
    const offersHumanInput =
      humanInputEnabled(humanInput) &&
      runIdOverride === undefined &&
      goalAttempt === undefined &&
      workflowStep === undefined;
    const humanInputServices: { current?: DurableRunDeps } = {};
    const humanInputEmitter = offersHumanInput
      ? new CompletableEventTarget<CombinedOperativeEventMap>()
      : undefined;
    const composeResolvedOptions = (resolved: RunOptions): RunOptions => {
      const withRuntime: RunOptions = { runtime: runtimeServices, ...resolved };
      return {
        ...withRuntime,
        ...(humanInputEmitter === undefined
          ? {}
          : {
              toolbox: wireDurableOptInTools(withRuntime.toolbox, humanInputServices, {
                humanInput: true,
                inputSchemas: humanInputSchemasOf(humanInput),
                wakeup: false,
                runId,
                humanInputEmitter,
              }),
            }),
        // COR-716 — the dispatching principal's asset resolver, unless the agent
        // supplied its own.
        ...unsetMediaOptions(withRuntime, runtime.mediaOptionsFor(ownerOrLocal(principal), 'run')),
        // A goal attempt's run is also fenced against its goal: it takes no step
        // once the goal ended or its own claim was tombstoned, and none until the
        // goal's record shows this attempt opened as running (goal-attempt-fence.ts).
        hooks: mergeHookRegistries(
          runtime.createBureauInvariantHooks(
            goalAttempt === undefined ? undefined : { ...goalAttempt, runId },
            { agentResolvesGuardrails },
          ),
          withRuntime.hooks,
        ),
      };
    };
    const resolveDurableAgent = async (): Promise<RunnableAgent<unknown, boolean>> => {
      let resolvedOptions: RunOptions;
      try {
        // Invoked through `definitionResolvingAgent`, not as a bare
        // extracted `resolver(...)` call — a resolver implemented as a
        // method reading instance state via `this` (a custom
        // `DefinitionResolvingAgent`, not necessarily `createAgent`'s own
        // arrow-function implementation) would otherwise lose its receiver
        // under strict-mode ESM. Matches `createLazyAgent`'s own resolver
        // forwarding for the same reason.
        resolvedOptions = composeResolvedOptions(
          await agent[OPERATIVE_RESOLVE_RUN_OPTIONS](input, context),
        );
      } catch (error) {
        // Review round 2 (Codex): `typeof resolver === 'function'` above
        // is true for EVERY `createLazyAgent`-wrapped agent unconditionally
        // — the wrapper always exposes this symbol as a proxy that only
        // discovers, once actually invoked, whether the module it loads
        // supports durable resolution at all. A lazy-wrapped agent whose
        // real underlying agent does NOT support it would otherwise always
        // be routed into this durable branch and fail here, even though
        // the exact same agent registered eagerly correctly falls back to
        // direct dispatch (see the "falls back to direct execution" test
        // above). `AgentContractError` is the established convention this
        // codebase already throws for "this capability is not supported"
        // (both here and inside `createLazyAgent`'s own resolver) — catch
        // exactly that class and fall back to the ORIGINAL catalog agent's
        // own `run()`, matching what direct registration would have done.
        // Anything else is a genuine resolver failure and must propagate.
        if (error instanceof AgentContractError) {
          // COR-851: a goal attempt's run is untracked and its activity retries
          // on failure, so a direct run here would be work no restart can find,
          // launched again by the retry. There is no fallback for an attempt.
          if (workflowStep !== undefined) {
            releaseAttribution();
            throw createBureauError(
              `Agent "${name}" cannot resolve its run options durably, so it cannot run a workflow step: ${error.message}`,
              'CONFLICT',
            );
          }
          if (goalAttempt !== undefined) {
            releaseAttribution();
            throw new GoalAttemptNotDurableCapableError(
              `Agent "${name}" cannot resolve its run options durably, so it cannot run a goal attempt: ${error.message}`,
            );
          }
          // AB-241: this fallback abandons the durable run behind `runId` —
          // the agent's own `run()` drives an in-memory run instead (under
          // the same id, through `context.runId`, COR-1302), which nothing
          // durable records, so an attribution entry recorded above under
          // `runId` would otherwise be a permanent phantom, keyed to a
          // durable run that never existed.
          releaseAttribution();
          return agent;
        }
        throw error;
      }
      // AB-240: persist a recovery record BEFORE starting the durable
      // engine, so a crash immediately after `engine.start` still leaves
      // enough, on the next boot, to reattach this run against the catalog
      // agent's OWN run options rather than the Bureau's default runtime
      // composition — a catalog dispatch has no bureau session to write
      // `lastRunId`/`lastRunStatus` onto (see `resolveRunServices`'s
      // catalog branch in runtime-composition.ts). A write failure here
      // propagates uncaught, same as every other resolver failure in this
      // function — better to fail this run's start than dispatch a durable
      // run with no way to reattach it later.
      // COR-1524 — a file agent's definition is stored before the recovery record that names its
      // hash exists: a record with no snapshot behind it could never be resumed. The run is tied
      // to the snapshot (`hold`) at once for a minted id, which no other execution can claim, and
      // only once the claim is won for a fixed one, so a start that loses never touches the
      // reference of the run that won.
      // Read before the snapshot is stored: the estimator is the one step between the store and
      // the guarded block below that can throw, and a throw there would leave a stored start
      // that nothing holds, abandons, or releases.
      const goalCostEstimation =
        goalAttempt === undefined
          ? undefined
          : goalAttemptCostEstimation(resolvedOptions.costEstimation);
      const fileStart = await fileAgents?.beginRunStart(agent);
      const fileBinding = fileStart?.binding;
      let heldReference = false;
      const recoveryRecord = {
        agentName: name,
        // Type-level-only correction (mirrors `agent-catalog.ts`'s own
        // `buildCatalogGenerationProfile` cast): `readGenerationProfile`
        // only reads `agent.generationProfile`, which doesn't depend on
        // `RunnableAgent`'s O/H type parameters, but its parameter type
        // defaults to `RunnableAgent<never, false>`, not structurally
        // assignable from `AnyRunnableAgent`'s `RunnableAgent<any, true>` half.
        definitionRevision: readGenerationProfile(agent).revision,
        input,
        // AB-241 review finding: without this, a durable catalog run that
        // crosses a process restart lost its attribution entirely — the
        // resumed resolver's rebuilt `AgentRunContext` carried no
        // `principal`, and `runAttribution` (in-memory only) started
        // empty on the new process.
        ...(principal !== undefined ? { principal } : {}),
        ...(fileBinding === undefined ? {} : { agentDefinitionHash: fileBinding.hash }),
        // COR-1481: the context the caller named, so a task rebuilt from this record keeps it.
        ...(runOptions?.sessionId === undefined ? {} : { contextId: runOptions.sessionId }),
        ...(goalAttempt === undefined ? {} : { goalAttempt }),
        ...(workflowStep === undefined ? {} : { workflowStep }),
        // COR-851: the estimator this run is configured with, written with the
        // claim, so pricing the attempt later never resolves the agent again.
        ...(goalCostEstimation === undefined ? {} : { costEstimation: goalCostEstimation }),
      };
      let claimLost = false;
      try {
        if (runIdOverride === undefined) {
          await fileStart?.hold(runId);
          heldReference = fileStart !== undefined;
          await runtime.persistCatalogRunRecoveryRecord(runId, recoveryRecord);
        } else {
          claimLost = !(await runtime.claimCatalogRunRecoveryRecord(runId, recoveryRecord));
          if (!claimLost) {
            await fileStart?.hold(runId);
            heldReference = fileStart !== undefined;
          }
        }
      } catch (error) {
        // The run never started, so nothing will settle or remove its reference.
        if (heldReference && runIdOverride === undefined) await fileAgents?.releaseRun(runId);
        else await fileStart?.abandon();
        throw error;
      }
      if (claimLost) {
        try {
          if (goalAttempt === undefined && workflowStep === undefined) {
            throw createBureauError(`Run "${runId}" already exists`, 'CONFLICT');
          }
          // Only the same attempt's own claim may be continued. A claim another
          // run, another goal, or another principal holds is never touched.
          const existing = await runtime.loadCatalogRunRecoveryRecord(runId);
          const owned =
            existing.status === 'found' &&
            (goalAttempt !== undefined
              ? existing.record.goalAttempt?.goalRunId === goalAttempt.goalRunId &&
                existing.record.goalAttempt.attemptIndex === goalAttempt.attemptIndex
              : existing.record.workflowStep?.workflowId === workflowStep?.workflowId &&
                existing.record.workflowStep?.step === workflowStep?.step) &&
            existing.record.agentName === name &&
            existing.record.principal === principal;
          if (!owned) {
            throw createBureauError(
              `Run "${runId}" already exists and does not belong to this goal attempt`,
              'CONFLICT',
            );
          }
          // A tombstoned claim is the goal saying it is over this attempt. It is the
          // pre-start half of the fence: the start stops here, before the engine is
          // asked for a workflow. A start that already passed this point is stopped
          // by the run's own fence instead, which also refuses any step until the goal
          // acknowledges the attempt as running (see goal-attempt-fence.ts).
          if (existing.record.goalAttempt?.tombstonedAt !== undefined) {
            releaseAttribution();
            throw new GoalAttemptTombstonedError(runId);
          }
          // The winning claim is immutable. Two at-least-once executions of one
          // attempt can overlap, and either may be the one whose workflow the
          // engine accepts, so a loser never rewrites what the winner wrote: the
          // record has to describe the workflow that runs, and the one claim
          // does. A workflow this execution still has to start is built from that
          // claim's own input and estimator, not from what this execution
          // resolved. A code-defined agent's claim cannot be rebuilt at the revision it
          // recorded (the catalog holds only the current one); recovery pins it and warns on a
          // drift, and this start is no different. A file agent's claim is rebuilt from its
          // snapshot at the revision the claim recorded (COR-1584), below.
          const claimed = existing.record;
          // COR-1524 — the claim's run began on a definition of a file agent that may since have
          // changed; this execution continues that run, so it is built from the claim's snapshot.
          let claimedAgent: AnyRunnableAgent & DefinitionResolvingAgentWithResolver = agent;
          if (claimed.agentDefinitionHash !== undefined && fileAgents !== undefined) {
            const recorded = await fileAgents.agentForRecordedRun(
              name,
              claimed.agentDefinitionHash,
              claimed.definitionRevision,
            );
            claimedAgent = recorded.agent as AnyRunnableAgent &
              DefinitionResolvingAgentWithResolver;
            // The run is the winner's, on the winner's snapshot: tie it there, then drop this
            // execution's own.
            await fileAgents.recordRunStart(claimedAgent, runId);
            heldReference = true;
          }
          await fileStart?.abandon();
          resolvedOptions = composeResolvedOptions(
            await claimedAgent[OPERATIVE_RESOLVE_RUN_OPTIONS](claimed.input, context),
          );
          if (claimed.costEstimation !== undefined) {
            resolvedOptions = {
              ...resolvedOptions,
              costEstimation: claimed.costEstimation ?? undefined,
            };
          }
        } catch (error) {
          // This execution lost, and keeps nothing of the run it will not start: the winner's
          // reference and snapshot are untouched, and this execution's snapshot is dropped.
          await fileStart?.abandon();
          throw error;
        }
      }
      const activeRun = createActiveRun(
        resolvedOptions,
        {
          engine: durable.engine,
          checkpointStore: durable.checkpointStore,
          runId,
          sessionId: runOptions?.sessionId ?? runId,
          ...(humanInputEmitter === undefined
            ? {}
            : {
                emitter: humanInputEmitter,
                onServices: (services: DurableRunDeps) => {
                  humanInputServices.current = services;
                },
              }),
        },
        // AB-241 — thread the caller-supplied principal into
        // `LivenessSnapshot.owner`, matching `createRunFromRequest`'s own
        // `request.principal !== undefined ? { owner: request.principal } : undefined`.
        principal !== undefined ? { owner: principal } : undefined,
      );
      dispatchedActiveRun = activeRun;
      // COR-1302 — only `runAgent` dispatches without an id override, so this
      // registers exactly the `bureau.run()` runs: a child or a goal attempt
      // always arrives with the id its owner recorded. Not registered when a
      // cancellation is pending: the handle was aborted or disposed while this
      // dispatch was still resolving, which settled its `result()` at once, so
      // this run exists only to carry that cancellation's durable cleanup and
      // must not make `getRun(run.id)` report a live run after its handle
      // already settled.
      if (runIdOverride === undefined && !cancellationRequested) {
        registerCatalogRun?.(activeRun);
      }
      if (cancellationRequested) {
        if (cancellationRequested.dispose) {
          activeRun[Symbol.dispose]();
        } else {
          activeRun.abort(cancellationRequested.reason);
        }
        // AB-291 (AC4): the real durable run's own acknowledgement for
        // THIS forwarded cancellation — `guardedRun.closed()` awaits it
        // below instead of the deferred wrapper's synthetic settlement.
        cancellationForward = activeRun.closed();
      }
      const agentRun = createAgentRun<unknown, boolean>(activeRun, {
        hasOutput: resolvedOptions.output !== undefined,
      });
      if (heldReference) {
        // The reference stays until the run ends, so a resume always finds its snapshot.
        detachBestEffortPromise(agentRun.result().finally(() => fileAgents?.settleRun(runId)));
      }
      return { name, hasOutput: resolvedOptions.output !== undefined, run: () => agentRun };
    };
    // AB-291 (AC4): wraps `resolveDurableAgent` purely to signal
    // `dispatchSettledPromise` once it settles — by then
    // `cancellationForward` above has its final value (set if a
    // cancellation was forwarded, left `undefined` otherwise). Never
    // swallows or alters `resolveDurableAgent`'s own result/rejection.
    const trackDispatchSettlement = async (): Promise<RunnableAgent<unknown, boolean>> => {
      try {
        const resolved = await resolveDurableAgent();
        if (durableStart !== undefined) {
          // No active run means the agent fell back to a direct run, which no
          // restart could find; a goal attempt must never end up there.
          if (dispatchedActiveRun === undefined) {
            durableStart.reject(
              new GoalAttemptNotDurableCapableError(
                `Agent "${name}" did not run durably, so it cannot run a goal attempt`,
              ),
            );
          } else {
            void (dispatchedActiveRun.durablyStarted ?? Promise.resolve()).then(
              durableStart.resolve,
              (error: unknown) => {
                // A start that never committed holds no workflow this share
                // protects; the retry, if any, keeps its own.
                releaseAttribution();
                durableStart.reject(error);
              },
            );
          }
        }
        return resolved;
      } catch (error) {
        durableStart?.reject(error);
        // AB-241: `resolveDurableAgent`'s `AgentContractError` fallback
        // (above) already deletes `runAttribution` for the abandoned
        // `runId` on ITS OWN success path (a `return`, not a throw). Any
        // other rejection here — `persistCatalogRunRecoveryRecord`
        // failing, `createActiveRun` throwing synchronously on an
        // unrepresentable `output` schema, a genuine resolver failure —
        // means this run never dispatched either, so the same cleanup
        // applies, mirroring `createRunFromRequest`'s own
        // `runAttribution.delete(runId)` for a run that "never reached
        // `store.register`" (see that catch block, below).
        releaseAttribution();
        throw error;
      } finally {
        dispatchSettled?.();
      }
    };
    const deferredRun = createDeferredAgentRun(trackDispatchSettlement, input, context, name);
    // AB-291 (AC4): computed once — `dispatchSettledPromise` resolves only
    // after `resolveDurableAgent` has settled, by which point
    // `cancellationForward` (set inside it, above) has its final value.
    // Reading `cancellationForward` lazily inside the `.then` (not
    // captured now) is required: this expression is built before that
    // assignment can possibly have happened yet.
    const closedSettlement: ReturnType<ActiveRun['closed']> = dispatchSettledPromise.then(
      () => cancellationForward ?? deferredRun.closed(),
    );
    // AB-291 (AC4 review finding): `closedSettlement`'s own genuine
    // acknowledgement, captured once it settles — read by `closed()`
    // below BEFORE `options.signal.aborted`, so a caller passing an
    // already-aborted signal AFTER the shared settlement has genuinely
    // resolved still gets the identical cached acknowledgement, per
    // `createClosedAcknowledgement`'s own post-settlement idempotency
    // guarantee ("a repeated call after the underlying cleanup has
    // genuinely settled returns the identical cached acknowledgement
    // object by reference"), rather than manufacturing a fresh
    // `unresolved`/`timed-out` result for a signal that arrived too late
    // to mean anything.
    let cachedAcknowledgement: Awaited<ReturnType<ActiveRun['closed']>> | undefined;
    // COR-772 — the reason the first `abort()` on this handle carried, for
    // the parent-cancellation policy applied once the run settles aborted.
    let abortReason: string | undefined;
    void closedSettlement.then((acknowledgement) => {
      cachedAcknowledgement = acknowledgement;
      return acknowledgement;
    });
    const guardedRun: AgentRun<unknown, boolean> = {
      ...deferredRun,
      abort(reason?: string): void {
        abortReason ??= reason;
        deferredRun.abort(reason);
        if (dispatchedActiveRun) {
          // No-op if `activeRun.abort()` already ran via the normal
          // `underlying.abort()` forwarding path — `AbortController.abort()`
          // (what `ActiveRun.abort()` calls under the hood) is idempotent.
          dispatchedActiveRun.abort(reason);
        } else if (!cancellationRequested) {
          cancellationRequested = { reason, dispose: false };
        }
      },
      [Symbol.dispose](): void {
        deferredRun[Symbol.dispose]();
        if (dispatchedActiveRun) {
          dispatchedActiveRun[Symbol.dispose]();
        } else if (!cancellationRequested) {
          cancellationRequested = { reason: undefined, dispose: true };
        }
      },
      // AB-291 (AC4): overrides `deferredRun.closed()` (otherwise inherited
      // via the `...deferredRun` spread above) — see `closedSettlement`'s
      // and `cancellationForward`'s doc comments for why the inherited one
      // can report `completed` before a forwarded cancellation's own
      // durable cleanup has even started. `options.signal` bounds THIS
      // caller's own wait only, matching every other `closed()`
      // implementation's per-call signal contract (never writes into the
      // shared `closedSettlement` cache).
      closed(options?: ClosedOptions): ReturnType<ActiveRun['closed']> {
        const signal = options?.signal;
        if (!signal) return closedSettlement;
        // Post-settlement idempotency guarantee: once the shared
        // acknowledgement has genuinely settled, every call — regardless
        // of a per-call signal's state — returns that identical cached
        // object, never a fresh `unresolved`/`timed-out` manufactured
        // from a signal that arrived after the fact.
        if (cachedAcknowledgement) return Promise.resolve(cachedAcknowledgement);
        if (signal.aborted) {
          return Promise.resolve({ status: 'unresolved', reason: 'timed-out' });
        }
        return new Promise((resolve) => {
          let settled = false;
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            resolve({ status: 'unresolved', reason: 'timed-out' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void closedSettlement.then((acknowledgement) => {
            if (settled) return acknowledgement;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(acknowledgement);
            return acknowledgement;
          });
        });
      },
    };
    detachBestEffortPromise(
      guardedRun.result().then((result) => {
        if (result.finishReason === 'aborted') onDurableRunAborted(runId, abortReason ?? 'Aborted');
        return undefined;
      }),
    );
    // COR-1630 — a goal attempt's claims are released by the goal forwarder, after the goal's
    // session holds the attempt's rows; every other durable dispatch is released from here.
    if (goalAttempt === undefined) reportWhenSettled(guardedRun, runId, principal);
    // A goal attempt is deliberately left out of `catalogRuns`. Shutdown aborts
    // every tracked run, and an attempt aborted by shutdown would end `aborted`
    // for good: its goal would read that as the attempt failing. Untracked, the
    // run is left to the engine's disposal, which is a crash for the next
    // process to recover, and the goal waits for it.
    return goalAttempt || workflowStep ? guardedRun : trackCatalogRun(guardedRun);
  }

  /**
   * COR-772 — what dispatching `name` as a child would look like, read before
   * anything starts so Bureau can record the child's workflow identity
   * first. `undefined` for an agent the catalog does not have.
   */
  function planChildRun(
    name: string,
  ): { readonly durable: boolean; readonly agentVersion: string } | undefined {
    const agent = agentCatalog.find(name);
    if (!agent) return undefined;
    return {
      durable: runtime.durable !== undefined && hasDefinitionResolver(agent),
      agentVersion: String(readGenerationProfile(agent).revision),
    };
  }

  /**
   * COR-772 — starts a catalog agent as the child Bureau's topology has
   * already recorded. Identical to `runAgent` except that the durable
   * workflow takes the child's recorded id, and the child's context carries
   * its correlation and signal port — never its parent's abort signal.
   */
  function startChildRun(start: ChildTopologyStart): AgentRun<unknown, boolean> {
    if (getShutdownPromise()) {
      throw createBureauError('Cannot start a child run: bureau is disposed', 'CONFLICT');
    }
    const agent = agentCatalog.find(start.agentName);
    if (!agent) {
      throw createBureauError(`Unknown agent "${start.agentName}"`, 'NOT_FOUND');
    }
    const context: AgentRunContext = {
      agentName: start.agentName,
      ...start.context,
      ...(start.principal === undefined ? {} : { principal: start.principal }),
      ...catalogRunGuardrailsContext(agent),
    };
    const hasResolver = hasDefinitionResolver(agent);
    if (runtime.durable && hasResolver) {
      return runDurableCatalogAgent(
        start.agentName,
        start.input,
        undefined,
        context,
        start.principal,
        agent,
        start.childRunId,
      );
    }
    // COR-1302 — the handle takes the id Bureau's topology recorded for this
    // child, which the durable branch above passes as its workflow id, so a
    // process-local child's handle carries the same id `children` reports.
    context.runId = start.childRunId;
    const fileReference = beginDirectFileReference(agent, context.runId);
    const direct = trackCatalogRun(
      settleDirectFileReference(
        createDeferredAgentRun(
          () =>
            resolveInvariantComposedAgent(
              start.agentName,
              start.input,
              context,
              start.principal,
              agent,
              hasResolver,
              undefined,
              fileReference,
            ),
          start.input,
          context,
          start.agentName,
        ),
        fileReference,
        context.runId,
      ),
    );
    // COR-1630 — see `runAgent`.
    if (hasResolver) reportWhenSettled(direct, context.runId, start.principal);
    return direct;
  }

  /**
   * COR-851 — starts one goal attempt as a durable catalog run under the
   * attempt's own deterministic id. Never falls back to an in-process run: a
   * goal attempt with no workflow behind it is one no restart could find, so
   * an agent that cannot run durably is refused here.
   */
  function startGoalAttemptRun(start: GoalAttemptStart): GoalAttemptRun {
    if (getShutdownPromise()) {
      throw createBureauError('Cannot start a goal attempt: bureau is disposed', 'CONFLICT');
    }
    const agent = agentCatalog.find(start.agentName);
    if (!agent) {
      throw createBureauError(`Unknown agent "${start.agentName}"`, 'NOT_FOUND');
    }
    if (!hasDefinitionResolver(agent)) {
      throw new GoalAttemptNotDurableCapableError(
        `Agent "${start.agentName}" cannot run durably, so it cannot run a goal attempt`,
      );
    }
    if (!runtime.durable) {
      throw createBureauError(
        `Agent "${start.agentName}" cannot run durably, so it cannot run a goal attempt`,
        'CONFLICT',
      );
    }
    const context: AgentRunContext = {
      agentName: start.agentName,
      ...(start.principal === undefined ? {} : { principal: start.principal }),
      ...catalogRunGuardrailsContext(agent),
    };
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    const durablyStarted = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // The caller awaits it, but a start that throws below never reaches that await.
    durablyStarted.catch(() => undefined);
    const run = runDurableCatalogAgent(
      start.agentName,
      start.input,
      undefined,
      context,
      start.principal,
      agent,
      start.runId,
      { goalRunId: start.goalRunId, attemptIndex: start.attemptIndex },
      { resolve: resolveStart, reject: rejectStart },
    );
    return { run, durablyStarted };
  }

  /**
   * COR-1527 — starts one `agent` step of a workflow file as a standalone durable catalog run under
   * the step's own deterministic id. Never falls back to an in-process run: a step with no
   * workflow behind it is one no restart could find. The run is not a task, is not offered
   * `requestHumanInput`, and is not aborted by shutdown, so an interrupted step resumes at the
   * next boot.
   */
  function startWorkflowStepRun(start: WorkflowStepStart): AgentRun<unknown, boolean> {
    if (getShutdownPromise()) {
      throw createBureauError('Cannot start a workflow step: bureau is disposed', 'CONFLICT');
    }
    const agent = agentCatalog.find(start.agentName);
    if (!agent) {
      throw createBureauError(`Unknown agent "${start.agentName}"`, 'NOT_FOUND');
    }
    if (!runtime.durable || !hasDefinitionResolver(agent)) {
      throw createBureauError(
        `Agent "${start.agentName}" cannot run durably, so it cannot run a workflow step`,
        'CONFLICT',
      );
    }
    validateAgentRunInput(start.input);
    const context: AgentRunContext = {
      agentName: start.agentName,
      ...(start.principal === undefined ? {} : { principal: start.principal }),
      ...catalogRunGuardrailsContext(agent),
    };
    return runDurableCatalogAgent(
      start.agentName,
      start.input,
      undefined,
      context,
      start.principal,
      agent,
      start.runId,
      undefined,
      undefined,
      start.workflowStep,
    );
  }

  /**
   * COR-1277 — the agent this non-durable dispatch actually runs: the catalog
   * agent itself when nothing can be composed onto it, and otherwise a
   * one-shot synthetic agent carrying Bureau's invariant tier in front of the
   * agent's own.
   *
   * **Where `createActiveRun` is called is the whole design.** It happens
   * inside the returned agent's `run()`, never here in the resolver.
   * `createDeferredAgentRun` checks `isTerminal()` after this function settles
   * and before calling `run()`, so an abort arriving during resolution settles
   * the handle synthetically and the underlying run never starts. That is why
   * this path needs no counterpart to `runDurableCatalogAgent`'s
   * `dispatchedActiveRun`/`cancellationRequested`/`guardedRun`/`closed()`
   * machinery: the durable branch calls `createActiveRun` inside ITS resolver,
   * before that gate (see the comment above `runDurableCatalogAgent`, which
   * says the gate decides whether to CALL `run()`, "not whether to have
   * started it"), so it has to forward the abort itself. This one does not
   * start anything the gate cannot still prevent.
   */
  async function resolveInvariantComposedAgent(
    name: string,
    input: AgentInput,
    context: AgentRunContext,
    principal: string | undefined,
    agent: AnyRunnableAgent,
    hasResolver: boolean,
    /** COR-1302 — receives the run this dispatch builds; see `registerCatalogRun`. */
    onActiveRun?: (activeRun: ActiveRun) => void,
    /** COR-1524 — settles once a file agent's snapshot is stored; a failure stops the start. */
    fileReference?: Promise<unknown>,
  ): Promise<RunnableAgent<unknown, boolean>> {
    // An agent exposing no `OPERATIVE_RESOLVE_RUN_OPTIONS` builds its
    // `RunOptions` entirely inside `run()`, so there is no bag to merge a tier
    // into and nothing here can change that (COR-1276's accepted gap). It runs
    // exactly as it did before this function existed.
    //
    // Handed the caller's already-computed boolean rather than re-running
    // `hasDefinitionResolver` here, because the capability is a GETTER on the
    // agent and re-running the guard would read it a second time. A test pins
    // that read count at one for this path ("reads the resolver capability
    // before the direct-dispatch durability branch"), and a lazily-wrapped
    // agent is entitled to treat a read as meaningful.
    if (!hasResolver) return agent as RunnableAgent<unknown, boolean>;

    let resolvedOptions: RunOptions;
    try {
      // The cast is what the boolean above costs: `hasResolver` carries the
      // narrowing that the guard would have applied, but not in a form the
      // compiler tracks across a parameter. Sound because the caller computed
      // it from this exact agent, immediately before.
      resolvedOptions = await (agent as unknown as DefinitionResolvingAgentWithResolver)[
        OPERATIVE_RESOLVE_RUN_OPTIONS
      ](input, context);
    } catch (error) {
      // Same fallback the durable branch makes, for the same reason: a
      // `createLazyAgent` wrapper exposes this symbol unconditionally and only
      // discovers on invocation whether the module behind it supports durable
      // resolution. `AgentContractError` means "not supported" — fall back to
      // the agent's own `run()`, which is what direct registration would have
      // done. This is NOT the no-resolver case above; that one never gets here.
      if (error instanceof AgentContractError) {
        return agent as RunnableAgent<unknown, boolean>;
      }
      // Any other resolution failure is a genuine one, and it must keep
      // settling as it does today. Before this change the same failure happened
      // inside `agent.run()` and `createDeferredAgentRun` classified it as an
      // `AgentContractError` ("threw synchronously from run()"); rethrowing
      // here instead would reclassify it as a LOAD_FAILED load error. Deferring
      // the throw to `run()` keeps the class the caller already sees.
      return {
        name,
        hasOutput: agent.hasOutput,
        run: () => {
          throw error;
        },
      };
    }

    // AB-260, matching the durable branch: a catalog agent's own resolver
    // builds its options independently of this bureau's composition, so
    // without this it would fall back to operative's default RuntimeServices.
    // Parity rather than a behavior change — `createAgent`'s own
    // `buildRunOptions` always populates `runtime`, so for an ordinary agent
    // the spread below leaves the agent's value in place, and this only bites
    // for a hand-written resolver that omits it.
    resolvedOptions = { runtime: runtimeServices, ...resolvedOptions };

    // COR-1524 — the snapshot is stored before the run starts.
    await fileReference;

    const merged: RunOptions = {
      ...resolvedOptions,
      ...unsetMediaOptions(
        resolvedOptions,
        runtime.mediaOptionsFor(ownerOrLocal(principal), 'run'),
      ),
      // Bureau first, so it wins `runFirst` and — being pinned last — still
      // wins the waterfall. Only the invariants that close over nothing
      // run-specific travel here; see `createBureauInvariantHooks`.
      hooks: mergeHookRegistries(
        runtime.createBureauInvariantHooks(undefined, {
          agentResolvesGuardrails: resolvesOwnGuardrails(agent),
        }),
        resolvedOptions.hooks,
      ),
    };
    const hasOutput = merged.output !== undefined;

    return {
      name,
      // The resolved options, not `agent.hasOutput`: the durable branch reads
      // it the same way, so a hand-written agent whose runtime witness
      // disagrees with its own schema cannot mint a mismatched handle.
      hasOutput,
      run: () => {
        const activeRun = createActiveRun(
          merged,
          undefined,
          // `createActiveRun` derives `LivenessSnapshot.owner` from this
          // argument alone, never from `RunOptions.principal`. `agent.run()`
          // supplies it internally today, so omitting it here would silently
          // report `owner: undefined` on every principal-carrying run.
          principal !== undefined ? { owner: principal } : undefined,
        );
        onActiveRun?.(activeRun);
        return createAgentRun<unknown, boolean>(activeRun, { hasOutput });
      },
    };
  }

  /**
   * COR-1524 — begin recording a direct (not durable) run of a file agent: its snapshot is stored
   * and the run tied to it. Resolves the binding, or `undefined` for any other agent; the promise
   * is started with the handle, so a handle aborted while it is still resolving is covered by
   * {@link settleDirectFileReference} like any other.
   */
  function beginDirectFileReference(
    agent: object,
    runId: string | undefined,
  ): Promise<unknown> | undefined {
    if (fileAgents === undefined || runId === undefined) return undefined;
    const recorded = fileAgents.recordRunStart(agent, runId);
    // Observed here, so a failure is not unhandled; the run start awaits it and fails with it.
    recorded.catch(() => undefined);
    return recorded;
  }

  /** Settle the reference once the handle ends, after the snapshot it names was stored. */
  function settleDirectFileReference(
    handle: AgentRun<unknown, boolean>,
    recorded: Promise<unknown> | undefined,
    runId: string | undefined,
  ): AgentRun<unknown, boolean> {
    if (recorded === undefined || runId === undefined) return handle;
    detachBestEffortPromise(
      handle.result().finally(() =>
        recorded.then(
          (binding) => (binding === undefined ? undefined : fileAgents?.settleRun(runId)),
          () => undefined,
        ),
      ),
    );
    return handle;
  }

  return {
    planChildRun,
    startChildRun,
    startGoalAttemptRun,
    startWorkflowStepRun,
  };
}
