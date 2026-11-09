import {
  isToolboxBudgetExceededToolError,
  type AnyToolbox,
  type ToolExecutionResult,
} from 'armorer';
import type { JSONValue, ToolCall } from 'armorer/protocol';
import { Conversation, materializeToolCalls } from 'conversationalist';

import { GuardrailTripwireError, reclassifyToolError } from './errors';
import {
  RunErrorEvent,
  StepAbortedEvent,
  ToolResultValidatedEvent,
  ToolSettledBubbleEvent,
  ToolsExecutedEvent,
  ToolsExecutingEvent,
} from './events';
import type { StepGeneratedMediaAdmitter } from './generated-media';
import {
  guardrailBlockedMessage,
  guardrailBlockedResult,
} from './guardrails/tool-result-guardrail';
import type { ErrorRecoveryAction } from './hooks/types';
import { modelFacingToolResult } from './human-wait-parks';
import { assistantMessageIdentifier, toolCallMessageIdentifiers } from './message-identifiers';
import { runScopedExecutionContext } from './run-scoped-execution-context';
import type { EventDispatcher, StepDeps, StepOutcome } from './run-step';
import { dispatchSettledResults, resultRowBatch, sealDanglingToolCalls } from './run-step-support';
import {
  applyWaterfallHandlerErrorPolicy,
  explicitAbortReason,
  guardrailReporter,
} from './run-step-utilities';
import { admitToolResultMedia, retainToolResultMedia } from './tool-result-media';
import { ToolTimingRecorder } from './tool-timing';
import type { GenerateResponse } from './types';

export interface ToolExecutionDependencies {
  deps: StepDeps;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
  signal: AbortSignal | undefined;
  stepSignal: AbortSignal;
  abortStep: (reason?: string) => void;
  elicit: ReturnType<typeof import('./run-step-support').createElicit> | undefined;
  toolCallInputs: GenerateResponse['toolCalls'];
  emittedSettledCallIds: Set<string>;
  stepAbortController: AbortController;
  stepToolbox: AnyToolbox;
  /** The step's media admitter: tool-result media is admitted through it before it is kept. */
  admitter?: StepGeneratedMediaAdmitter | undefined;
  /**
   * Metadata for the first tool-call message, when the step appended no
   * assistant message to carry it (a response with tool calls and no text).
   */
  firstToolCallMetadata?: Record<string, JSONValue> | undefined;
}

export interface ToolExecutionResultSet {
  materializedToolCalls: ToolCall[];
  results: ToolExecutionResult[];
}

export async function executeTools(
  input: ToolExecutionDependencies,
): Promise<ToolExecutionResultSet | StepOutcome> {
  const {
    deps,
    conversation,
    step,
    emitter,
    signal,
    stepSignal,
    elicit,
    stepToolbox,
    toolCallInputs,
    emittedSettledCallIds,
    stepAbortController,
    firstToolCallMetadata,
    admitter,
  } = input;
  const mediaContext = { step, runId: deps.runId };
  const { hooks } = deps;
  let materializedToolCalls: ToolCall[] = [];
  let results: ToolExecutionResult[] = [];
  const resultRowScope = { runId: deps.runId, step };
  // When each call ran, on the run's clock: its result row records it (`tool-timing.ts`).
  const timing = new ToolTimingRecorder(() => deps.runtime.clock.nowISO());
  /**
   * Admits a step's result rows, appends them, then claims the managed assets they now point at,
   * so none expires under its row. Every committed row passes through admission here, whatever a
   * hook did to it on the way; media admitted already is a managed asset and passes unchanged.
   * An append failure throws; a retention failure is returned, for the caller to report.
   */
  const commitToolResults = async (
    unadmitted: ToolExecutionResult[],
  ): Promise<{ error: unknown } | undefined> => {
    const rows = await admitToolResultMedia(admitter, unadmitted, mediaContext);
    // The conversation is what the model reads; the step record keeps the results as they were.
    const modelRows = rows.map(modelFacingToolResult);
    timing.endAll();
    const batch = resultRowBatch(resultRowScope, rows, timing);
    if (deps.collectAsync) {
      await conversation.appendToolResultsAsync(modelRows, batch);
    } else {
      conversation.appendToolResults(modelRows, batch);
    }
    try {
      await retainToolResultMedia(
        { admitter: deps.generatedMediaAdmitter, runId: deps.runId, conversation },
        rows,
      );
      return undefined;
    } catch (error) {
      return { error };
    }
  };

  if (toolCallInputs.length > 0) {
    materializedToolCalls = materializeToolCalls(toolCallInputs);
    const assistantMessageId = assistantMessageIdentifier(deps.runId, step);
    const callRowIds = toolCallMessageIdentifiers(
      assistantMessageId,
      materializedToolCalls,
      assistantMessageId !== undefined &&
        conversation
          .getMessages({ includeHidden: true })
          .some((message) => message.id === assistantMessageId),
    );
    const [firstCall, ...otherCalls] = materializedToolCalls;
    if (firstToolCallMetadata !== undefined && firstCall !== undefined) {
      conversation.appendToolCall(firstCall, {
        metadata: firstToolCallMetadata,
        ...(callRowIds === undefined ? {} : { messageId: callRowIds[0]! }),
      });
      conversation.appendToolCalls(
        otherCalls,
        callRowIds === undefined ? undefined : { messageIds: callRowIds.slice(1) },
      );
    } else {
      conversation.appendToolCalls(
        materializedToolCalls,
        callRowIds === undefined ? undefined : { messageIds: callRowIds },
      );
    }

    let callsToExecute = materializedToolCalls;
    let filteredResults: ToolExecutionResult[] = [];

    if (hooks?.has('beforeToolExecution')) {
      try {
        // Iterated by hand rather than dispatched: `beforeToolExecution`
        // waterfalls a FIELD of its context (`toolCalls`) while the rest of
        // the context stays fixed, so the context is rebuilt around each
        // handler's result. `run()` would instead replace the whole context
        // with a bare
        // `ToolCall[]` for the second handler. Invocations still go through
        // `runHandler` so an observer sees them like any dispatched hook.
        // A throwing handler goes through the policy `run()` applies (the handler's own `onError`,
        // then the registry's), so `'continue'` skips it and `'abort'` or no policy fails the step.
        for (const [index, entry] of hooks.getHandlers('beforeToolExecution').entries()) {
          const beforeContext = {
            conversation,
            step,
            toolCalls: [...callsToExecute],
            elicit,
            reportGuardrail: guardrailReporter(emitter, step),
          };
          let registryResult: unknown;
          try {
            registryResult = await hooks.runHandler('beforeToolExecution', entry, [beforeContext]);
          } catch (handlerError) {
            applyWaterfallHandlerErrorPolicy(
              handlerError,
              'beforeToolExecution',
              index,
              entry.options,
              hooks.onError,
              entry.id,
            );
            continue;
          }
          if (registryResult !== undefined) {
            callsToExecute = registryResult as ToolCall[];
          }
        }
      } catch (error) {
        const sealedResults = await sealDanglingToolCalls(
          conversation,
          deps.collectAsync,
          'Tool execution aborted before a result could be produced (beforeToolExecution hook failed)',
          undefined,
          resultRowScope,
        );
        dispatchSettledResults(
          emitter,
          deps,
          step,
          materializedToolCalls,
          sealedResults,
          emittedSettledCallIds,
        );
        emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
        return { kind: 'error', error, errorKind: 'tool' };
      }
    }

    // A beforeToolExecution hook can legitimately filter the call list down
    // (or to empty) without throwing. Every filtered-out call was already
    // appended to the conversation via appendToolCalls above and now has no
    // path to a result — seal it here rather than leaving it dangling for a
    // later provider replay to choke on.
    if (callsToExecute.length < materializedToolCalls.length) {
      const executingIds = new Set(callsToExecute.map((tc) => tc.id));
      const filteredOutCalls = materializedToolCalls.filter((tc) => !executingIds.has(tc.id));
      const synthesizedResults = await sealDanglingToolCalls(
        conversation,
        deps.collectAsync,
        'Tool execution skipped by beforeToolExecution hook',
        filteredOutCalls,
        resultRowScope,
      );
      dispatchSettledResults(
        emitter,
        deps,
        step,
        filteredOutCalls,
        synthesizedResults,
        emittedSettledCallIds,
      );
      filteredResults = synthesizedResults;
    }

    if (callsToExecute.length > 0) {
      emitter?.dispatch(new ToolsExecutingEvent(step, callsToExecute));
      let executedResults: ToolExecutionResult[] = [];

      try {
        // AB-233/AB-300/COR-814 — thread the active trace context and a
        // per-execution `executionContext` (this run's child registry, its
        // own run id, its own delegated-authority grant, and its own parent
        // signal port) through to every tool call. `executionContext`
        // merges the caller's own `deps.executeOptions.executionContext` (if
        // any) under the run-derived fields, so a caller-supplied key
        // survives unless it collides with `childRegistry`/`parentRunId`/
        // `delegatedAuthority`/`parentSignals`.
        const { concurrency, mode, errorMode, ...baseExecuteOptions } = deps.executeOptions ?? {};
        const runScopedContext = runScopedExecutionContext(deps);
        const toolboxExecuteOptions = {
          ...baseExecuteOptions,
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(mode === undefined ? {} : { mode }),
          ...(errorMode === undefined ? {} : { errorMode }),
          signal: stepSignal,
          // AB-290: stamp this run's own id as `ownerId` on every armorer
          // execution this call dispatches — after the caller's own
          // `executeOptions`, so this run's identity always wins over
          // anything a caller supplied there. `createActiveRun`'s bubble
          // listeners (`create-run.ts`/`active-run-adapter.ts`) filter
          // `tool.started`/`tool.settled`/`tool.progress` by this same id,
          // replacing the old `ownedToolCallIds`/`ToolCall.id` tracking,
          // which was never guaranteed unique across concurrent runs
          // sharing one `Toolbox`.
          ...(deps.runId !== undefined ? { ownerId: deps.runId } : {}),
          ...(deps.parentContext !== undefined ? { traceContext: deps.parentContext } : {}),
          ...(runScopedContext !== undefined
            ? {
                executionContext: {
                  // COR-2106 — the run-scoped fields come from the one function a host also uses
                  // to resume a parked call, so a field added there reaches both.
                  ...runScopedContext,
                  ...(deps.requestChildWait !== undefined && deps.runId !== undefined
                    ? {
                        durableChildWait: (request: { childRunId: string; toolCallId: string }) => {
                          const toolCall = callsToExecute.find(
                            (call) => call.id === request.toolCallId,
                          );
                          const tool =
                            toolCall === undefined
                              ? undefined
                              : stepToolbox.resolveTool(toolCall.name);
                          if (
                            tool === undefined ||
                            !tool.ok ||
                            tool.tool.metadata?.['durableChildWait'] !== true ||
                            deps.childWaitPrincipal === undefined
                          )
                            return { parked: false as const, reason: 'unauthorized' as const };
                          return deps.requestChildWait?.({
                            parentRunId: deps.runId!,
                            childRunId: request.childRunId,
                            toolCallId: request.toolCallId,
                            principal: deps.childWaitPrincipal,
                          });
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(deps.durableOperationKeys &&
          deps.runId !== undefined &&
          deps.executeOptions?.durableOperationKey === undefined
            ? {
                durableOperationKey: (call: ToolCall, index: number) =>
                  `schedule-safe:${deps.runId}:step-${step}:tool-${index}:${call.name}`,
              }
            : {}),
        };

        const onForwardedSettled = (event: Event) => {
          if (!(event instanceof ToolSettledBubbleEvent)) return;
          if (
            event.runId === deps.runId &&
            callsToExecute.some((call) => call.id === event.toolCallId)
          ) {
            emittedSettledCallIds.add(event.toolCallId);
            timing.ended(event.toolCallId);
          }
        };
        const eventTarget = emitter instanceof EventTarget ? emitter : undefined;
        eventTarget?.addEventListener(ToolSettledBubbleEvent.type, onForwardedSettled);
        let executeResult: ToolExecutionResult | ToolExecutionResult[];
        timing.started(callsToExecute.map((call) => call.id));
        try {
          executeResult =
            deps.parentContext !== undefined && deps.withTraceContext !== undefined
              ? await deps.withTraceContext(deps.parentContext, () =>
                  stepToolbox.execute(
                    callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                    toolboxExecuteOptions,
                  ),
                )
              : await stepToolbox.execute(
                  callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                  toolboxExecuteOptions,
                );
        } finally {
          eventTarget?.removeEventListener(ToolSettledBubbleEvent.type, onForwardedSettled);
        }

        const pendingChildCallId = deps.getPendingChildWait?.()?.toolCallId;
        executedResults = await admitToolResultMedia(
          admitter,
          (Array.isArray(executeResult) ? executeResult : [executeResult]).filter(
            (result) => result.toolCallId !== pendingChildCallId,
          ),
          mediaContext,
        );
        // COR-1628 — a call the toolbox answers without executing it (a refusal by the active
        // skills' `allowed-tools` gate) never emits a toolbox `settled` event, so settle it
        // here. A call whose settlement was already forwarded is skipped by the shared set.
        // A live stream settles when it ends, through the forwarded event, so it is left out.
        dispatchSettledResults(
          emitter,
          deps,
          step,
          callsToExecute,
          executedResults.filter((result) => result.stream === undefined),
          emittedSettledCallIds,
        );
        results.push(...executedResults);
      } catch (error) {
        // onError recovery for tool execution phase.
        // Iterate handlers manually to avoid waterfall type mismatch.
        // Wrapped in try/catch so a throwing onError handler doesn't
        // bypass the error result path — if the hook itself fails, we
        // fall through to normal error propagation using the original error.
        let recovered = false;
        if (hooks?.has('onError')) {
          try {
            const toolErrorContext = {
              error,
              step,
              phase: 'tool-execution' as const,
              conversation,
              retryCount: 0,
              maxRetries: 0,
            };
            let errorAction: ErrorRecoveryAction | undefined;
            const toolErrorHandlers = hooks.getHandlers('onError');
            for (const entry of toolErrorHandlers) {
              const result = await (
                entry.handler as (
                  context: typeof toolErrorContext,
                ) => Promise<ErrorRecoveryAction | void>
              )(toolErrorContext);
              if (result === undefined) continue;
              errorAction = result;
              break;
            }

            if (errorAction === 'skip') {
              // Append error results for each dangling tool call so the
              // conversation stays valid (tool calls without corresponding
              // tool results break most LLM APIs on the next generate call).
              results = callsToExecute.map((tc) => ({
                callId: tc.id,
                toolCallId: tc.id,
                ...(tc.providerCallId === undefined ? {} : { providerCallId: tc.providerCallId }),
                toolName: tc.name,
                outcome: 'error' as const,
                content: 'Tool execution skipped by onError hook',
                result: 'Tool execution skipped by onError hook',
              }));
              dispatchSettledResults(
                emitter,
                deps,
                step,
                callsToExecute,
                results,
                emittedSettledCallIds,
              );
              recovered = true;
            }
            // 'retry' and 'abort' both propagate for tool execution
          } catch {
            // The onError hook itself threw — fall through to normal error
            // propagation using the original error so that makeErrorResult,
            // onRunError, and RunErrorEvent all fire as expected.
          }
        }
        if (!recovered) {
          const sealedResults = await sealDanglingToolCalls(
            conversation,
            deps.collectAsync,
            'Tool execution failed before a result could be produced',
            undefined,
            resultRowScope,
            timing,
          );
          dispatchSettledResults(
            emitter,
            deps,
            step,
            callsToExecute,
            sealedResults,
            emittedSettledCallIds,
          );
          // Re-classify a toolbox-level, failFast BUDGET_EXCEEDED rejection
          // to `BudgetExceededError` here, upstream of `makeErrorResult`'s
          // `instanceof` classification, so the run's `finishReason`
          // resolves to `'budget-exceeded'` instead of falling through to
          // `'error'` (AB-231).
          const runError = reclassifyToolError(error);
          emitter?.dispatch(new RunErrorEvent(step, runError, 'tool'));
          return { kind: 'error', error: runError, errorKind: 'tool' };
        }
      }

      // Validate tool results guardrail
      if (hooks?.has('validateToolResult')) {
        const validatedResults: ToolExecutionResult[] = [];
        try {
          for (const originalResult of results) {
            let currentResult = originalResult;
            {
              const snapshot = { ...currentResult };
              const validated = await hooks.run('validateToolResult', currentResult, {
                conversation,
                step,
                toolCalls: callsToExecute,
                results,
                elicit,
                reportGuardrail: guardrailReporter(emitter, step),
              });
              const replaced = validated !== undefined && validated !== currentResult;
              // A hook can replace the result or mutate it in place, so whatever it leaves is
              // admitted before the event shows it or the row keeps it; media admitted already
              // is a managed asset and passes through unchanged.
              const [admitted] = await admitToolResultMedia(
                admitter,
                [replaced ? validated : currentResult],
                mediaContext,
              );
              const next = admitted ?? (replaced ? validated : currentResult);
              if (replaced) emitter?.dispatch(new ToolResultValidatedEvent(step, snapshot, next));
              currentResult = next;
            }
            validatedResults.push(currentResult);
          }
          results = validatedResults;
        } catch (error) {
          // COR-2103: a tool-result tripwire halts the run, as an input or output tripwire does,
          // and is never recovered. The call stays paired, but not with what tripped it: the
          // flagged result, and every result after it that no guardrail has read, is withheld.
          if (error instanceof GuardrailTripwireError) {
            const message = guardrailBlockedMessage(error.guardrailName);
            const withheld = results
              .slice(validatedResults.length)
              .map((result) => guardrailBlockedResult(result, message));
            results = [...validatedResults, ...withheld];
            await commitToolResults(results);
            emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
            return { kind: 'error', error, errorKind: 'policy' };
          }
          // Validation failed, but the underlying tool execution already
          // produced real results — seal the tool calls with those
          // (unvalidated) results rather than leaving them dangling.
          // The rows are admitted and retained as the normal path's are, whatever a hook did to
          // them before it threw; the validation error is what the step reports either way.
          await commitToolResults(results);
          emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
          return { kind: 'error', error, errorKind: 'tool' };
        }
      }

      const retention = await commitToolResults(results);
      if (retention !== undefined) {
        emitter?.dispatch(new RunErrorEvent(step, retention.error, 'tool'));
        return { kind: 'error', error: retention.error, errorKind: 'tool' };
      }

      emitter?.dispatch(new ToolsExecutedEvent(step, callsToExecute, executedResults));

      // COR-1915: a call the toolbox's own `budget` (calls or time) refused ends the run as
      // `budget-exceeded`, as a failFast rejection does (AB-231). Every later call would be
      // refused the same way, so letting the model carry on would only spend steps. The rows are
      // committed above, so the conversation keeps a result for every call.
      const refused = results.find(
        (result) => result.outcome === 'error' && isToolboxBudgetExceededToolError(result.error),
      );
      if (refused !== undefined) {
        const runError = reclassifyToolError(refused.error);
        emitter?.dispatch(new RunErrorEvent(step, runError, 'tool'));
        return { kind: 'error', error: runError, errorKind: 'tool' };
      }

      if (stepSignal.aborted && !signal?.aborted) {
        emitter?.dispatch(
          new StepAbortedEvent(step, explicitAbortReason(stepAbortController.signal)),
        );
        return { kind: 'continue' };
      }

      if (hooks?.has('afterToolExecution')) {
        try {
          await hooks.run('afterToolExecution', {
            conversation,
            step,
            toolCalls: callsToExecute,
            results,
            elicit,
            reportGuardrail: guardrailReporter(emitter, step),
          });
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
          return { kind: 'error', error, errorKind: 'tool' };
        }
      }
    }

    // Filtered calls were sealed above and must not be re-appended or sent
    // through execution result validation. They remain part of the public
    // step result alongside the actual executed results, after hooks have
    // observed only the calls and results that actually executed. Keep this
    // merge outside the execution guard so an all-filtered batch still exposes
    // its sealed results through StepResult and step.completed.
    results.push(...filteredResults);

    // Preserve provider call order for synthesized-only batches as well as
    // mixed executed/skipped batches. StepResult and its terminal event must
    // match the conversation's original tool-call order.
    const resultByCallId = new Map(results.map((result) => [result.toolCallId, result]));
    results = materializedToolCalls
      .map((call) => resultByCallId.get(call.id))
      .filter((result): result is ToolExecutionResult => result !== undefined);
  }

  return { materializedToolCalls, results };
}
