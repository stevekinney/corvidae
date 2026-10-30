import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ToolExecutionResult } from 'armorer';
import type { ToolCall } from 'armorer/protocol';
import { Conversation } from 'conversationalist';
import type { ZodType } from 'zod';

import { accumulateRequestCost, getModelPricing, seedAccumulatedCost } from './cost-estimation';
import { AgentRunError } from './errors';
import {
  ElicitationRequestedEvent,
  ElicitationResolvedEvent,
  ToolSettledBubbleEvent,
  UsageAccumulatedEvent,
} from './events';
import { toolResultMessageIdentifier } from './message-identifiers';
import type { EventDispatcher, RunState, StepDeps } from './run-step';
import type {
  ElicitationOptions,
  ElicitationResponse,
  OnElicitation,
  RunOptions,
  TokenUsage,
} from './types';

export function createElicitationRequester(
  step: number,
  onElicitation: OnElicitation,
  conversation: Conversation,
  signal: AbortSignal | undefined,
  runtime: RuntimeServices,
  emitter: EventDispatcher | undefined,
) {
  return async <T>(
    message: string,
    schema: ZodType<T>,
    options?: ElicitationOptions,
  ): Promise<ElicitationResponse<T>> => {
    const requestId = runtime.identifiers.next('elicitation');
    // Capture the caller-supplied correlation before invoking the callback.
    // Hooks may mutate their options object while the callback is pending;
    // that must not change which request this invocation owns.
    const toolCallId = options?.toolCallId;
    const request = Object.freeze({
      requestId,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      message,
      schema,
      context: { conversation, step, signal },
    });
    emitter?.dispatch(new ElicitationRequestedEvent(step, message, requestId, toolCallId));
    const elicitation = onElicitation(request).catch((error) => {
      if (signal?.aborted) return null;
      throw error;
    });
    let removeAbortListener: (() => void) | undefined;
    const aborted = signal
      ? new Promise<null>((resolve) => {
          const onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
        })
      : undefined;
    let response: ElicitationResponse<T>;
    try {
      response = await (aborted ? Promise.race([elicitation, aborted]) : elicitation);
    } finally {
      removeAbortListener?.();
    }
    if (signal?.aborted) {
      emitter?.dispatch(new ElicitationResolvedEvent(step, false, requestId, toolCallId));
      return null;
    }
    if (
      response !== null &&
      (response.requestId !== requestId || response.toolCallId !== toolCallId)
    ) {
      throw new AgentRunError('Elicitation response did not match its request.', {
        kind: 'contract',
        code: 'UNKNOWN',
      });
    }
    const accepted = response !== null;
    emitter?.dispatch(new ElicitationResolvedEvent(step, accepted, requestId, toolCallId));
    return response;
  };
}

/** Projects the shared request lifecycle to the hook's data-or-null contract. */
export function createElicit(...parameters: Parameters<typeof createElicitationRequester>) {
  const request = createElicitationRequester(...parameters);
  return async <T>(
    message: string,
    schema: ZodType<T>,
    options?: ElicitationOptions,
  ): Promise<T | null> => {
    const response = await request(message, schema, options);
    return response === null ? null : response.data;
  };
}

/** What names a step's `tool-result` rows: its run and its step number. */
export interface ResultRowScope {
  readonly runId: string | undefined;
  readonly step: number;
}

/**
 * The row ids for appending `results`, derived from the run and step; `undefined`
 * when the run has no id, so the conversation mints them.
 */
export function resultRowBatch(
  scope: ResultRowScope | undefined,
  results: ReadonlyArray<{ readonly callId: string }>,
): { messageIds: string[] } | undefined {
  if (scope === undefined || scope.runId === undefined) return undefined;
  const { runId, step } = scope;
  return {
    messageIds: results.map((result) => toolResultMessageIdentifier(runId, step, result.callId)!),
  };
}

/**
 * Seals the given tool calls with a synthesized error result. Called on
 * every unrecovered error/abort path that runs after
 * `conversation.appendToolCalls` — a `beforeToolExecution` hook throwing (or
 * legitimately filtering calls out without executing them), unrecovered
 * tool-execution failure, or a `validateToolResult` hook throwing — so a
 * killed or errored run never leaves a dangling `tool-call` message behind.
 * A dangling tool-call breaks replay: every provider adapter requires a
 * `tool_use`/`tool_call` to have a paired result before the conversation can
 * be sent to the model again (durable resume, retry-from-history, etc.).
 *
 * `calls` defaults to every currently-pending tool call in the conversation
 * — the right default once no more tool calls are still awaiting execution
 * (e.g. after a hook throws, or after execution itself fails). Pass an
 * explicit subset when other calls are still legitimately in flight (e.g.
 * calls a `beforeToolExecution` hook filtered out while `callsToExecute`
 * still awaits execution).
 */
export async function sealDanglingToolCalls(
  conversation: Conversation,
  collectAsync: boolean,
  reason: string,
  calls: ReadonlyArray<ToolCall> = conversation.getPendingToolCalls(),
  rowScope?: ResultRowScope,
): Promise<ToolExecutionResult[]> {
  if (calls.length === 0) return [];

  const danglingResults = calls.map((tc) => ({
    callId: tc.id,
    toolCallId: tc.id,
    ...(tc.providerCallId === undefined ? {} : { providerCallId: tc.providerCallId }),
    toolName: tc.name,
    outcome: 'error' as const,
    content: reason,
    result: reason,
  }));

  const batch = resultRowBatch(rowScope, danglingResults);
  if (collectAsync) {
    await conversation.appendToolResultsAsync(danglingResults, batch);
  } else {
    conversation.appendToolResults(danglingResults, batch);
  }
  return danglingResults;
}

export function dispatchSettledResults(
  emitter: EventDispatcher | undefined,
  deps: StepDeps,
  step: number,
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolExecutionResult>,
  emittedCallIds: Set<string>,
): void {
  if (!emitter) return;
  const callsById = new Map(calls.map((call) => [call.id, call]));
  for (const result of results) {
    const callId = result.toolCallId;
    if (emittedCallIds.has(callId)) continue;
    const call = callsById.get(callId);
    if (!call) continue;
    emittedCallIds.add(callId);
    emitter.dispatch(
      new ToolSettledBubbleEvent(
        { agentName: deps.agentName ?? '', runId: deps.runId ?? '', step },
        {
          toolName: call.name,
          toolCallId: call.id,
          status: result.outcome === 'success' ? 'success' : 'error',
          result: result.result,
          error: result.outcome === 'success' ? undefined : (result.error ?? result.result),
        },
      ),
    );
  }
}

/**
 * The model a step's request is priced at (COR-1914). A session switched to another model runs a
 * step on it, and that step must cost what that model charges, not what the agent's default
 * charges, or a budget could be spent at a rate it never counted. The switched model is used when
 * the run's pricing knows it; otherwise the run's own `costEstimation.model` stands.
 */
export function costModelOfStep(
  costEstimation: NonNullable<RunOptions['costEstimation']>,
  stepModel: string | undefined,
): string {
  if (stepModel === undefined || stepModel === costEstimation.model) return costEstimation.model;
  return getModelPricing(stepModel, costEstimation.pricing) === undefined
    ? costEstimation.model
    : stepModel;
}

/**
 * Folds a step's token usage into `runState.totalUsage` and dispatches
 * `UsageAccumulatedEvent`. Extracted so the validate-response tripwire path
 * (which returns an error result before the main usage-accumulation block)
 * can still record usage for a response the provider already billed —
 * otherwise a tripwire fired by the default output guardrail would report
 * zero usage/cost for a completed, metered generate call.
 */
export function accumulateUsage(
  runState: RunState,
  emitter: EventDispatcher | undefined,
  step: number,
  usage: TokenUsage | undefined,
  costEstimation: RunOptions['costEstimation'],
  stepModel?: string,
): void {
  if (usage) {
    // Priced per request here, where the request's own usage is still separate from the sum.
    if (costEstimation) {
      const model = costModelOfStep(costEstimation, stepModel);
      // The accumulator must always cover all of `totalUsage`. Usage that arrived with no cost
      // (a checkpoint from before costs were accumulated) is seeded at the base tier first, or
      // the terminal estimate would count only the requests made after the resume.
      runState.cost ??= seedAccumulatedCost(
        runState.totalUsage,
        costEstimation.model,
        costEstimation.pricing,
      );
      runState.cost = accumulateRequestCost(runState.cost, usage, model, costEstimation.pricing);
    }
    runState.totalUsage.prompt += usage.prompt;
    runState.totalUsage.completion += usage.completion;
    runState.totalUsage.total += usage.total;
    // Cache fields are provider-neutral but not universally reported. Only
    // accumulate when this step's usage actually carried the field, and only
    // materialize it on the run total once a step has reported it — an
    // absent field must never be fabricated as `0`.
    if (usage.cacheCreationTokens !== undefined) {
      runState.totalUsage.cacheCreationTokens =
        (runState.totalUsage.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens !== undefined) {
      runState.totalUsage.cacheReadTokens =
        (runState.totalUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
  }
  emitter?.dispatch(new UsageAccumulatedEvent(step, { ...runState.totalUsage }, usage));
}
