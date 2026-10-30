import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { AnyToolbox } from 'armorer';
import type { MediaContent, MultiModalContent } from 'conversationalist';
import { Conversation } from 'conversationalist';
import type { ZodType } from 'zod';

import type { ContextEpochSealer } from './context-epoch';
import type { AccumulatedCost } from './cost-estimation';
import type { EffectiveContextTail, StoredEffectiveContext } from './effective-context-record';
import { type AgentRunErrorKind, GeneratedMediaNotAdmittedError } from './errors';
import {
  GenerateCompletedEvent,
  ResponseValidatedEvent,
  RunErrorEvent,
  StepAbortedEvent,
} from './events';
import { createStepGeneratedMediaAdmitter, type GeneratedMediaAdmission } from './generated-media';
import { assistantMessageIdentifier } from './message-identifiers';
import {
  checkChatCostBudget,
  checkCostBudget,
  openStepCostWindow,
  type StepCostWindow,
} from './run-step-cost-budget';
import { finalizeStep } from './run-step-finalization';
import { executeGeneration } from './run-step-generation';
import { prepareStep } from './run-step-preparation';
import { partsOf, settleResponse } from './run-step-response';
import { commitAssistantRow } from './run-step-row';
import { accumulateUsage, pricedModelNameOfStep } from './run-step-support';
import { executeTools } from './run-step-tools';
import { explicitAbortReason, guardrailReporter } from './run-step-utilities';
import type { SelectionGate } from './selection-gate';
import type { ToolChoice } from './structured-output/types';
import type {
  ContextManagementOptions,
  GenerateContext,
  OnElicitation,
  RetryOptions,
  RunOptions,
  SteeringGate,
  StepResult,
  StopCondition,
  TokenUsage,
} from './types';

export { awaitResumeOrAbort, normalizeToArray, runHookSilently } from './run-step-utilities';

/**
 * Minimal structural type for an event emitter. The loop and step never depend
 * on the concrete `CompletableEventTarget`; they only dispatch.
 */
export type EventDispatcher = {
  dispatch(event: Event): boolean;
};

/**
 * The default safety bound on step count when {@link RunOptions.maximumSteps} is
 * not set. Shared by every driver — the in-memory `executeLoop`, the run-level
 * lifecycle, and the durable `agentRun` workflow — so the in-memory and durable
 * paths can never silently disagree on how many steps an unbounded run takes.
 */
export const DEFAULT_MAXIMUM_STEPS = 25;

/**
 * The loop-invariant dependencies of a run. Every field is derived once from
 * {@link RunOptions} before the step loop begins and never mutated. Splitting
 * the run's ~20 locals into this immutable bag plus the mutable {@link RunState}
 * is what lets a single step be a self-contained, relocatable unit — and what
 * lets the durable driver checkpoint only the small, cloneable {@link RunState}.
 */
export interface StepDeps {
  readonly generate: RunOptions['generate'];
  readonly toolbox: AnyToolbox;
  readonly executeOptions: RunOptions['executeOptions'];
  readonly signal: AbortSignal | undefined;
  readonly collectAsync: boolean;
  readonly retry: RetryOptions | undefined;
  readonly backpressure: RunOptions['backpressure'];
  readonly onElicitation: OnElicitation | undefined;
  readonly hooks: RunOptions['hooks'];
  readonly contextManagement: ContextManagementOptions | undefined;
  /** Projects media parts to a source form the provider accepts (COR-716). */
  readonly contentSourceResolver: RunOptions['contentSourceResolver'];
  /** The policy for a resolved asset with no safety verdict (COR-716). */
  readonly assetSafety: RunOptions['assetSafety'];
  /**
   * Admits generated media as managed assets (COR-713). Bound per step into the
   * `GenerateContext` the loop hands `generate`.
   */
  readonly generatedMediaAdmitter: RunOptions['generatedMediaAdmitter'];
  /** Costs media parts; defaults to a catalog estimator over the generate function's descriptors. */
  readonly mediaCostEstimator: RunOptions['mediaCostEstimator'];
  readonly output: ZodType | undefined;
  readonly responseFormat: GenerateContext['responseFormat'];
  /** Per-request output token cap passed through to every GenerateContext. */
  readonly maximumTokens: number | undefined;
  readonly schemaRetries: number;
  readonly schemaRetryMessage: RunOptions['schemaRetryMessage'];
  readonly parentContext: unknown;
  readonly withTraceContext: RunOptions['withTraceContext'];
  readonly runId: string | undefined;
  /**
   * AB-233 — this run's own child registry, passed to every tool call as
   * `ToolContext.executionContext.childRegistry` (see the toolbox execute
   * call site below), not captured once at tool-construction time.
   */
  readonly childRegistry: RunOptions['childRegistry'];
  /**
   * AB-300 — this run's own already-attenuated delegated-authority grant,
   * passed to every tool call as
   * `ToolContext.executionContext.delegatedAuthority` (see the toolbox
   * execute call site below), matching `childRegistry`'s own AB-233
   * pattern.
   */
  readonly delegatedAuthority: RunOptions['delegatedAuthority'];
  /**
   * COR-814 — this run's own end of its parent's typed signal channel,
   * passed to every tool call as `ToolContext.executionContext.parentSignals`
   * (see the toolbox execute call site), matching `delegatedAuthority`.
   */
  readonly parentSignals: RunOptions['parentSignals'];
  readonly durableOperationKeys: boolean;
  readonly defaultToolChoice: ToolChoice | undefined;
  /**
   * The AB-67 runtime steering gate, threaded from `RunOptions.steering`.
   * `undefined` when the run has no steering dependency configured — the
   * boundary read below is skipped entirely and behavior is unchanged.
   */
  readonly steering: SteeringGate | undefined;
  /**
   * The AB-64/AB-250 selection-revalidation gate, threaded from
   * `RunOptions.selection`. `undefined` when the run has no selection
   * dependency configured — the boundary read below is skipped entirely
   * and behavior is unchanged.
   */
  readonly selection: SelectionGate | undefined;
  /**
   * COR-581's effective-context epoch sealer, threaded from
   * `RunOptions.contextEpoch`. `undefined` when the run composes none —
   * the seal below is skipped entirely and `generate.started` carries no
   * `contextEpochId`, exactly as before.
   */
  readonly contextEpoch: ContextEpochSealer | undefined;
  readonly stopConditions: StopCondition[];
  /** Maximum number of retries the onError hook can request per step. */
  readonly maxErrorRetries: number;
  /**
   * AB-92/AB-252 — the run's resolved `RuntimeServices` instance. Every
   * wall-clock, monotonic-duration, timer, and randomness read inside this
   * step goes through it, never a real global directly.
   */
  readonly runtime: RuntimeServices;
  readonly agentName: string | undefined;
  /** Prices each request's usage into `RunState.cost`; `undefined` accumulates no cost. */
  readonly costEstimation: RunOptions['costEstimation'];
  /**
   * The run's spend limit (COR-1914). Checked after each step against `RunState.cost`, so it has
   * no effect without `costEstimation`.
   */
  readonly costBudget: RunOptions['costBudget'];
  /**
   * AB-204: when supplied, every run-owned hook's fire-and-forget promise
   * (`onLLMInput`/`onLLMOutput` here; `onRunComplete`/`onRunAbort`/
   * `onRunError` in `run-lifecycle.ts`) is handed to this callback so
   * `closed()` can await genuine hook completion instead of acknowledging
   * cleanup while a hook is still running. `undefined` for a caller that
   * doesn't need the acknowledgement (e.g. a bare `executeLoop` caller that
   * never calls `closed()`) — hooks still run exactly the same either way.
   */
  readonly hookTracker?: ((promise: Promise<unknown>) => void) | undefined;
  /**
   * COR-713: every media admission a step starts is handed here, as `hookTracker` receives hooks,
   * so a run's terminal result and `ActiveRun.closed()` wait for each admission to settle instead
   * of acknowledging cleanup while a generated asset is still pending.
   */
  readonly admissionTracker?: ((admission: GeneratedMediaAdmission) => void) | undefined;
  /**
   * AB-239 — invoked by `runStep` itself ONCE, at step start, with that
   * step's resolved toolbox (`deps.toolbox`, or a `selectTools`
   * replacement), immediately after resolution. The driver (`loop.ts`'s
   * `executeLoop` / `run-workflow.ts`) invokes the SAME callback a second
   * time, at step end (after `runStep` returns) with `deps.toolbox` — so
   * across one step this fires twice: swapped-or-base at start, base at end.
   * Lets the driver (`create-run.ts` / `active-run-adapter.ts`) keep
   * `toolbox.*` event forwarding attached to whichever toolbox instance this
   * step actually executes tools against, for exactly that step's duration.
   * `undefined` for a driver that builds no run emitter (e.g.
   * `startDurableRunResult`'s headless scheduler runs) — see
   * `ToolboxEventForwarder`.
   */
  readonly onStepToolbox?: ((toolbox: AnyToolbox) => void) | undefined;
}

/**
 * The mutable, run-level accumulators carried across steps. Every field is
 * plain and cloneable so the durable driver can checkpoint it directly. The
 * `Conversation` is the one non-plain piece; it is carried alongside (a live
 * instance in `executeLoop`, rehydrated from a snapshot per step in the durable
 * driver) and never embedded in `RunState`.
 */
export interface RunState {
  steps: StepResult[];
  totalUsage: TokenUsage;
  /**
   * The cost of every request folded into `totalUsage`, each priced on its own usage and added at
   * the same point (`accumulateUsage`), so the two cannot drift apart. `undefined` until a priced
   * request is recorded, or for a run with no `costEstimation`.
   */
  cost?: AccumulatedCost | undefined;
  lastContent: string;
  /**
   * The parts of the run's final assistant row (COR-713), set wherever `lastContent` is: the last
   * step's settled parts, or the `onMaximumSteps` replacement row's parts when it replaced it.
   */
  lastParts: readonly MultiModalContent[];
  /**
   * True when the final row is an `onMaximumSteps` replacement rather than the last step's row, so
   * the run-wide `RunResult.parts` adds `lastParts` after the steps instead of repeating a step.
   */
  finalRowIsReplacement: boolean;
  /** Run-scoped count of structured-output schema retries already consumed. */
  schemaAttempts: number;
  /**
   * The `configVersion` `SteeringAppliedEvent` last fired for, on this run.
   * AB-221: `steering.applied` fires once per accepted command — once per
   * distinct `configVersion` this run observes at the boundary — never once
   * per step. `0` (the default, un-steered `SteeringDesiredState.configVersion`)
   * never fires: it means no command has ever been accepted.
   */
  lastAppliedConfigVersion: number;
  /**
   * COR-1810 — the conversation the run's previous stored step saw, which a durable run carries
   * across steps (`RunCursor.effectiveContextTail`) so a step stores its effective context as a
   * delta from it. `undefined` stores it whole.
   */
  effectiveContextTail?: EffectiveContextTail | undefined;
  /**
   * COR-1810 — the stored form of the effective context of the step generated last, set with
   * `StepResult.effectiveContext`, for the durable writer to put on the step's record.
   */
  storedEffectiveContext?: StoredEffectiveContext | undefined;
}

/**
 * The discriminated result of a single {@link runStep} call. The driver
 * switches on `kind` to reproduce the original loop's control flow:
 *
 * - `next`: the step completed; advance to the next step.
 * - `continue`: re-enter the loop without advancing the run-level result —
 *   used for skipped steps, per-step aborts, and schema-retry re-prompts (the
 *   user message is already appended and `schemaAttempts` already bumped).
 * - `stop`: a stop condition fired; the run finishes successfully.
 * - `abort`: the run-level signal aborted; the driver builds the abort result.
 * - `error`: an error escaped recovery; the driver builds the error result.
 */
export type StepOutcome =
  | { kind: 'next' }
  | { kind: 'continue' }
  | {
      kind: 'stop';
      // A step only ever stops the run by a stop condition firing; `maximum-steps`
      // is decided by the driver's loop bound, not a step.
      finishReason: 'stop-condition';
      schemaValidation?: { success: boolean; error?: unknown } | undefined;
      /** The validated structured output — set only on a successful `schemaValidation`. */
      output?: unknown;
    }
  | { kind: 'abort'; reason?: string | undefined }
  | { kind: 'error'; error: unknown; errorKind?: AgentRunErrorKind | undefined };

/**
 * Executes exactly one iteration of the agent loop against a live
 * {@link Conversation}, mutating it in place and pushing any completed step
 * into `runState.steps`. This is the entire per-step body extracted verbatim
 * from the original `executeLoop` `for` body — generate (with retry, hooks,
 * and the `prepareStep`/`beforeGenerate`/`afterGenerate` waterfall), the
 * `onError` recovery do/while, response validation, tool execution and its
 * `onError` recovery, tool-result validation, the `afterToolExecution` hooks,
 * stop-condition evaluation, and the structured-output schema-retry decision.
 *
 * The single behavioral change versus the inline body is mechanical: where the
 * inline body did `return makeAbortResult(...)`, `return makeErrorResult(...)`,
 * `continue`, or `return runResult`, this returns a discriminated
 * {@link StepOutcome} and lets the driver reproduce that control flow. The
 * schema-retry `continue` (originally `loop.ts:1014`) is an end-of-step
 * decision — the correction user message is appended and `runState.schemaAttempts`
 * is bumped before returning `{ kind: 'continue' }` — so it is a clean step
 * boundary, not mid-step re-entry. That is what makes the durable driver able
 * to call this same function once per `yield*`-delimited step.
 */
export async function runStep(
  deps: StepDeps,
  runState: RunState,
  conversation: Conversation,
  step: number,
  emitter: EventDispatcher | undefined,
): Promise<StepOutcome> {
  // COR-1914: the budget is measured from the spend the step began with, so a billed response the
  // step discarded still counts. A step that reaches finalization is checked there; one that
  // moves on without (an `onError` skip, an aborted step) is checked here, and one that ends the
  // run is not: the run is over either way.
  // COR-1915: a chat that had spent its budget before the run began stops it at its first step,
  // before any model call. A run past its first step is never asked.
  if (runState.steps.length === 0) {
    try {
      checkChatCostBudget(deps);
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
      return { kind: 'error', error, errorKind: 'policy' };
    }
  }
  const costWindow = openStepCostWindow(runState);
  const outcome = await runStepBody(deps, runState, conversation, step, emitter, costWindow);
  if (costWindow.checked || (outcome.kind !== 'continue' && outcome.kind !== 'next')) {
    return outcome;
  }
  try {
    checkCostBudget({ deps, runState, emitter, step, window: costWindow });
  } catch (error) {
    emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
    return { kind: 'error', error, errorKind: 'policy' };
  }
  return outcome;
}

async function runStepBody(
  deps: StepDeps,
  runState: RunState,
  conversation: Conversation,
  step: number,
  emitter: EventDispatcher | undefined,
  costWindow: StepCostWindow,
): Promise<StepOutcome> {
  const { signal, hooks } = deps;
  if (signal?.aborted) {
    return { kind: 'abort', reason: explicitAbortReason(signal) };
  }

  // AB-67 steering boundary: read the session's desired steering state
  // exactly once per step, at this shared entry point (both the in-memory
  // `executeLoop` `for` loop and the durable `run-workflow.ts` per-step
  // `ctx.memo` reach this once per step, never mid-generate, mid-tool-
  // execution, or on a same-step retry). `deps.steering` is undefined for a
  // run with no steering dependency configured — that is a complete no-op,
  // matching today's non-steerable behavior exactly.
  //
  // Each read is copied (`{ ...state }`), never the gate's own returned
  // reference: a real gate is free to keep one mutable desired-state object
  // it updates in place as commands are admitted, and forwarding that live
  // reference into `GenerateContext.steering` would let a later mutation
  // become visible to this step's already-captured context — the exact
  // same-step leak the mid-step-admission acceptance criterion forbids.
  //
  // AB-221: dispatch `steering.applied` for a desired state this boundary
  // just read, deduplicated by `configVersion` — extracted so it can run
  // after EVERY boundary read below, not only after the pause-wait loop
  // exits. This matters for pause/resume specifically: AB-67's pause row
  // fixes the application boundary as "entry of runStep" and its terminal
  // behavior as "applied at the boundary" — the read itself is what applies
  // a pause, independent of whether the driver then blocks waiting for a
  // resume. Firing only once, after the loop, would silently skip the
  // `applied` event for every `configVersion` that was paused-and-read but
  // then superseded by a later command before the loop exited — under-
  // counting exactly the command class this boundary exists to gate.
  //
  // Fires at most once per distinct `configVersion` this run observes:
  // `configVersion` increments by exactly one per accepted command (AB-67),
  // so "once per accepted command" is exactly "once per distinct
  // `configVersion` observed here" — `RunState.lastAppliedConfigVersion` is
  // the dedupe key, carried across steps for both drivers (in-memory: the
  // same `RunState` instance persists across the loop; durable: threaded
  // through `RunCursor.lastAppliedConfigVersion` like `schemaAttempts`).
  // `configVersion === 0` is the un-steered default (no command ever
  // accepted) and never fires.
  //
  // `deps.runId` is required to stamp `SteeringEffectiveState.appliedAtRunId`
  // (a required field — there is no honest way to leave it unset). AB-236
  // closes this at the type level: `RunOptions` makes `runId` required
  // whenever `steering` is set (see `types.ts`'s `RunOptions` doc comment),
  // so a real caller can no longer construct a steering-enabled `RunOptions`
  // with no `runId` — `buildStepDeps`/`executeLoop`/`createActiveRun` always
  // thread one through. This `deps.runId !== undefined` check stays as
  // defense in depth against `StepDeps` built by hand (bypassing
  // `RunOptions` entirely, as `run-step.test.ts`'s
  // "never fires when the run has no runId" test does) rather than a
  // reachable gap in any real driver.
  //
  // NOT solved here, same root cause for both: `SteeringDesiredState` is an
  // AGGREGATE — one `configVersion` covering every steerable field at once,
  // with no per-target or applied-history information (AB-67's ratified
  // shape) — so this boundary cannot distinguish "this bump changed a field
  // that applies now" from "this bump changed a field that applies later"
  // or "from a field this run already consumed."
  //
  // - A session whose `configVersion` a PRIOR run already applied.
  //   `RunState.lastAppliedConfigVersion` is per-run, so a new run starting
  //   fresh re-observes and re-fires for a `configVersion` an earlier run
  //   on the same session already applied.
  // - `agentName` (an `agent-identity` command): AB-67 fixes its effective
  //   boundary as the FIRST STEP OF THE SESSION'S NEXT RUN, not the current
  //   run's next boundary read — "agent-identity commands stay `accepted`
  //   and carry forward to the next run's boundary." This boundary has no
  //   way to know a `configVersion` bump was identity-only (or identity
  //   bundled with an in-run field like `route`) versus purely an in-run
  //   field, so it currently reports EVERY bump as applied to the current
  //   run, including one that should not take effect until the next run.
  //   Diffing the previous and current `SteeringDesiredState` snapshots
  //   in-place to detect "only `agentName` changed" would still be wrong
  //   for the bundled case — the stamped `SteeringEffectiveState.agentName`
  //   would claim effect for a run whose already-resolved agent, toolbox,
  //   generator, and hooks never actually changed.
  //
  // Both need the `SteeringGate` itself — read-only from this boundary's
  // side (`getDesiredState()`/`awaitResume()`) — to carry target- and
  // history-aware write-side state: which fields are due now versus at the
  // next run boundary, and what a prior run already consumed. That is
  // AB-199's `SteeringGate` implementation's responsibility, not this
  // boundary's; AB-221's own scope excludes reopening AB-67's
  // `SteeringDesiredState`/`RunOptions` shapes to add it.
  const preparation = await prepareStep({ deps, runState, conversation, step, emitter });
  if ('kind' in preparation) return preparation;
  const {
    steeringDesiredState,
    stepAbortController,
    stepSignal,
    abortStep,
    elicit,
    stepToolbox,
    stepToolChoice,
    resolvedSources,
    admission,
  } = preparation;
  costWindow.model = deps.costEstimation
    ? pricedModelNameOfStep(deps.costEstimation, steeringDesiredState)
    : undefined;

  const admitter = createStepGeneratedMediaAdmitter({
    port: deps.generatedMediaAdmitter,
    runId: deps.runId,
    step,
    signal: stepSignal,
    track: deps.admissionTracker,
  });

  const generation = await executeGeneration({
    deps,
    runState,
    admitter,
    conversation,
    step,
    emitter,
    stepSignal,
    abortStep,
    elicit,
    steeringDesiredState,
    stepToolbox,
    stepToolChoice,
    resolvedSources,
    admission,
  });
  if ('kind' in generation) return generation;
  const { stepSkipped, generateDurationMilliseconds, streamedRowId } = generation;
  let { response } = generation;

  // If the step was skipped via onError recovery, move to the next step
  if (stepSkipped) return { kind: 'continue' };

  // Validate response guardrail
  if (hooks?.has('validateResponse')) {
    try {
      const originalResponse = { ...response };
      const validated = await hooks.run('validateResponse', response, {
        conversation,
        step,
        signal: stepSignal,
        abortStep,
        elicit,
        reportGuardrail: guardrailReporter(emitter, step),
      });
      // COR-713: the response the validation hooks leave is authoritative, whether a hook returned
      // a replacement or edited the one it was handed in place. Settle it either way, before the
      // event or the commit below can see parts the hook did not mean to keep.
      const effective = validated ?? response;
      const settled = await settleResponse(effective, 'validateResponse', { step, admitter });
      if (settled !== response) {
        emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, settled));
      }
      response = settled;
    } catch (error) {
      // See the comment on the validateResponseHooks catch above — the
      // response has already been billed by the provider.
      accumulateUsage(
        runState,
        emitter,
        step,
        response.usage,
        deps.costEstimation,
        steeringDesiredState,
      );
      // A cancellation that interrupted a media admission is the cancellation, not an error.
      if (error instanceof GeneratedMediaNotAdmittedError && signal?.aborted) {
        return { kind: 'abort', reason: explicitAbortReason(signal) };
      }
      emitter?.dispatch(new RunErrorEvent(step, error, 'output'));
      return { kind: 'error', error, errorKind: 'output' };
    }
  }

  // AB-302: dispatch `generate.completed` here, after BOTH output-guardrail
  // validation blocks above (`deps.validateResponseHooks` — e.g. the
  // `createGuardrails().validateResponse` hook bureau wires into that array
  // for its default and caller-supplied guardrail presets — and the
  // `validateResponse` hook registry), rather than immediately after the
  // raw provider response comes back. A guardrail configured with
  // `action: 'redact'` (or `'block'`) replaces `response.content` in those
  // blocks; consumers of this live event frame (SSE/WebSocket subscribers,
  // OTel spans, any `generate.completed` listener) must see that
  // substituted content, never the pre-guardrail original, so the event
  // frame carries the same content the run's final result carries. Only
  // fires when an actual generate call happened this step —
  // `generateDurationMilliseconds` stays `undefined` when a `prepareStep`
  // hook short-circuited generation entirely (see its declaration above),
  // matching this function's prior behavior of never emitting
  // `generate.completed` for a prepareStep-short-circuited step.
  //
  // Streaming deltas (`stream:text-delta`, emitted by
  // `withEnhancedStreaming`/`composeConfiguredGenerate` while the provider
  // call above is still in flight) are a separate surface, and they are
  // pre-guardrail by construction: nothing here holds them back. Bureau does
  // not buffer them and does not produce them either (COR-1806): it wires no
  // `streamEventTarget`, so the frames its AG-UI mount sends for a run's text
  // and reasoning are read from the recorded events that follow this point, a
  // `generate.completed` that carries the response the guardrails left. A host
  // that wires streaming itself owns keeping a delta from a client until its
  // output guardrail has run.
  if (generateDurationMilliseconds !== undefined) {
    emitter?.dispatch(new GenerateCompletedEvent(step, response, generateDurationMilliseconds));
  }

  if (signal?.aborted) {
    return { kind: 'abort', reason: explicitAbortReason(signal) };
  }

  if (stepSignal.aborted && !signal?.aborted) {
    emitter?.dispatch(new StepAbortedEvent(step, explicitAbortReason(stepAbortController.signal)));
    return { kind: 'continue' };
  }

  const { content, usage, metadata } = response;
  const parts = partsOf(response);
  runState.lastContent = content;
  runState.lastParts = parts;
  runState.finalRowIsReplacement = false;
  accumulateUsage(runState, emitter, step, usage, deps.costEstimation, steeringDesiredState);

  // COR-713: the row carries the settled parts, not only the text. A step that is a thinking block
  // and a tool call has no text and still has a row to keep. The row takes the id a streaming client
  // was shown (`<runId>:step:<n>`), or a minted one for a run with no id.
  const { messageId } = commitAssistantRow({
    conversation,
    parts,
    metadata,
    streamedRowId,
    rowId: assistantMessageIdentifier(deps.runId, step),
  });

  // The row now points at the assets it carries. A port that retains generated assets claims them
  // here, so none can expire while the row exists; the claim is released with the row's lifecycle.
  const retain = deps.generatedMediaAdmitter?.retainCommitted?.bind(deps.generatedMediaAdmitter);
  if (retain !== undefined && messageId !== undefined) {
    const managed = parts.filter(
      (part): part is MediaContent => 'source' in part && part.source.kind === 'managed-asset',
    );
    if (managed.length > 0) {
      try {
        await retain({ runId: deps.runId, messageId, parts: managed });
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error, 'output'));
        return { kind: 'error', error, errorKind: 'output' };
      }
    }
  }

  // A step that committed no row (a response with tool calls and no parts) would otherwise lose
  // its metadata (the request's media lineage): stamp the lineage on the step's first tool-call
  // message instead.
  const inputLineage = metadata?.['inputLineage'];
  const lineageOnToolCall =
    messageId === undefined && inputLineage !== undefined ? { inputLineage } : undefined;

  const toolExecution = await executeTools({
    deps,
    firstToolCallMetadata: lineageOnToolCall,
    conversation,
    step,
    emitter,
    signal,
    stepSignal,
    abortStep,
    elicit,
    stepToolbox,
    toolCallInputs: response.toolCalls,
    emittedSettledCallIds: new Set<string>(),
    stepAbortController,
    admitter,
  });
  if ('kind' in toolExecution) return toolExecution;
  const { materializedToolCalls, results } = toolExecution;

  return finalizeStep({
    deps,
    runState,
    conversation,
    step,
    emitter,
    response,
    parts,
    messageId,
    materializedToolCalls,
    results,
    contextEpochId: generation.contextEpochId,
    planReason: generation.planReason,
    effectiveContext: generation.effectiveContext,
    costWindow,
  });
}
