import type { AnyToolbox } from 'armorer';
import type { ResolvedMediaSources } from 'conversationalist';
import { Conversation } from 'conversationalist';

import type { SteeringDesiredState } from './durable/types';
import {
  GeneratedMediaNotAdmittedError,
  GuardrailTripwireError,
  MediaAdmissionError,
  ResponsePartsMismatchError,
} from './errors';
import {
  GenerateErrorEvent,
  GenerateStartedEvent,
  ReplayDataDroppedEvent,
  RunErrorEvent,
} from './events';
import type { StepGeneratedMediaAdmitter } from './generated-media';
import { composeGenerationSelectionRecord } from './generation-selection-record';
import type { ErrorRecoveryAction } from './hooks/types';
import { isProviderContractError } from './providers/errors';
import { readDroppedReplayData } from './providers/shared/replay-data';
import type { EventDispatcher, RunState, StepDeps, StepOutcome } from './run-step';
import type { StepMediaAdmission } from './run-step-media';
import { settleResponse } from './run-step-response';
import { accumulateUsage, createElicit } from './run-step-support';
import {
  applyWaterfallHandlerErrorPolicy,
  callGenerateWithRetry,
  explicitAbortReason,
  runHookSilently,
} from './run-step-utilities';
import type { ToolChoice } from './structured-output/types';
import type { GenerateContext, GenerateResponse } from './types';

export interface GenerationDependencies {
  deps: StepDeps;
  /** Billed usage of a response the loop is about to discard is folded in here (COR-713). */
  runState: RunState;
  /** This step's media-admission port: carried on the `GenerateContext`, used to settle every response. */
  admitter: StepGeneratedMediaAdmitter;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
  stepSignal: AbortSignal;
  abortStep: (reason?: string) => void;
  elicit: ReturnType<typeof createElicit> | undefined;
  steeringDesiredState: SteeringDesiredState | undefined;
  stepToolbox: AnyToolbox;
  stepToolChoice: ToolChoice | undefined;
  /** The step boundary's derivation of the media sources, for the `prepareStep` hooks (COR-716). */
  resolvedSources: ResolvedMediaSources | undefined;
  /** This step's media admission; every `generate` call derives its own `resolvedSources` from it. */
  admission: StepMediaAdmission;
}

export interface GenerationResult {
  response: GenerateResponse;
  /**
   * The id of the row a streaming wrapper (or a `prepareStep` response claiming
   * `messageAppended`) already wrote for this step, read from the response `generate` returned,
   * before any hook could replace it. The commit step reconciles it with the settled response.
   */
  streamedRowId: string | undefined;
  stepSkipped: boolean;
  generateDurationMilliseconds: number | undefined;
}

export async function executeGeneration(
  input: GenerationDependencies,
): Promise<GenerationResult | StepOutcome> {
  const {
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
  } = input;
  const { hooks, hookTracker, backpressure, signal } = deps;
  let response: GenerateResponse = undefined!;
  let streamedRowId: string | undefined;
  let stepRetryCount = 0;
  let shouldRetryStep: boolean;
  let stepSkipped = false;
  // AB-302: hoisted out of the generate block below so `GenerateCompletedEvent`
  // can be dispatched once, AFTER the output-guardrail validation blocks that
  // follow the retry loop (`deps.validateResponseHooks` and the
  // `validateResponse` hook registry) — never immediately after the raw
  // provider response comes back. Reset at the top of every retry iteration:
  // `undefined` after the loop means "no real generate call happened this
  // step" (the `prepareResult` short-circuit below never sets it), which is
  // also the signal the post-loop dispatch uses to skip the event entirely,
  // matching this function's prior behavior of never emitting
  // `generate.completed` for a prepareStep-short-circuited step.
  let generateDurationMilliseconds: number | undefined;
  do {
    shouldRetryStep = false;
    generateDurationMilliseconds = undefined;
    streamedRowId = undefined;
    try {
      let prepareResult: GenerateResponse | void = undefined;
      if (hooks?.has('prepareStep')) {
        const prepareContext = {
          conversation,
          step,
          signal: stepSignal,
          abortStep,
          elicit,
          resolvedSources,
        };
        // `runFirst`, not `run`: a `prepareStep` handler returns a
        // `GenerateResponse` but receives a `StepContext`, so the waterfall
        // would hand the next handler a response where it expects a context.
        // First answer wins and the rest are skipped.
        const registryResult = await hooks.runFirst('prepareStep', prepareContext);
        if (registryResult !== undefined) {
          prepareResult = registryResult;
        }
      }

      if (prepareResult) {
        streamedRowId = streamedRowOf(prepareResult, conversation);
        // A `prepareStep` response skips `generate`, so it takes the same derivation and media
        // admission a generated one does.
        response = await settleResponse(prepareResult, 'prepareStep', { step, admitter });
      } else {
        // beforeGenerate: waterfall that can modify the generate context
        let generateContext: GenerateContext = {
          conversation,
          step,
          signal: stepSignal,
          toolbox: stepToolbox,
          toolChoice: stepToolChoice,
          responseFormat: deps.responseFormat,
          maximumTokens: deps.maximumTokens,
          steering: steeringDesiredState,
          resolvedSources,
          generatedMediaAdmitter: admitter,
        };
        if (hooks?.has('beforeGenerate')) {
          // Iterate handlers manually (the same reason afterGenerate does,
          // below) rather than a single `hooks.run()` call: AB-67 requires
          // re-applying the boundary-read `steering` value after EVERY
          // handler, not only after the waterfall's final result, so an
          // earlier handler that omits or replaces it can never leave a
          // later handler observing missing or forged desired state.
          // `hooks.run()` has no hook between handlers to do that reapply.
          //
          // AB-232: a throwing handler is routed through the same policy
          // `run()` uses — `entry.options.onError`, falling back to the
          // registry-level `onError` exposed via `hooks.onError` — instead
          // of bypassing it, via `applyWaterfallHandlerErrorPolicy` above.
          const handlers = hooks.getHandlers('beforeGenerate');
          let beforeGenContext: GenerateContext = {
            conversation,
            step,
            toolbox: stepToolbox,
            toolChoice: stepToolChoice,
            responseFormat: deps.responseFormat,
            signal: stepSignal,
            steering: steeringDesiredState,
            resolvedSources,
            generatedMediaAdmitter: admitter,
          };
          for (const [index, entry] of handlers.entries()) {
            let handlerResult: GenerateContext | void;
            try {
              // `runHandler`, not `entry.handler(...)` directly: it applies
              // this registry's invocation observation, so a hand-iterated
              // hook is visible to a plan observer exactly as a dispatched
              // one is. Error policy stays here, where this loop's own
              // reapply-steering semantics live.
              handlerResult = (await hooks.runHandler('beforeGenerate', entry, [
                beforeGenContext,
              ])) as GenerateContext | void;
            } catch (error) {
              applyWaterfallHandlerErrorPolicy(
                error,
                'beforeGenerate',
                index,
                entry.options,
                hooks.onError,
                entry.id,
              );
              continue;
            }
            if (handlerResult !== undefined) {
              // AB-67: steering desired-configuration is not hook-overridable.
              // A `beforeGenerate` hook may replace every other field of
              // `GenerateContext`, but the session's boundary-read steering
              // state is re-applied here so a hook can never silently drop
              // or override it — for this handler's own return value, not
              // only the waterfall's last one.
              beforeGenContext = {
                ...handlerResult,
                steering: steeringDesiredState,
                resolvedSources,
                // COR-713: the media-admission port is the loop's, like `steering`.
                generatedMediaAdmitter: admitter,
              };
            }
          }
          generateContext = beforeGenContext;
        }

        // COR-716: the binding admission, on the exact conversation this call
        // receives, after the last hook that could change it. The derivation
        // is never carried over from the boundary preview: a `prepareStep` or
        // `beforeGenerate` handler may have appended or replaced media, and a
        // part the preview already resolved is memoized, so an unchanged
        // conversation costs no resolver call. Nothing this loop controls sits
        // between this derivation and the call; the two sites that do are
        // named in `run-step-media.ts` (a background compaction, which only
        // removes messages; a provider's own `pinnedMessages`).
        const bound = await admission.admit(generateContext.conversation);
        if ('kind' in bound) return bound;
        // COR-104: a cancellation can land while a handler's media resolves.
        if (signal?.aborted) {
          return { kind: 'abort', reason: explicitAbortReason(signal) };
        }
        generateContext = { ...generateContext, resolvedSources: bound.resolvedSources };

        // onLLMInput: parallel allSettled, read-only, non-blocking. AB-204:
        // handed to hookTracker so closed() can await it — it can still be
        // running when this run's result settles. `runHookSilently` must
        // run unconditionally here — `hookTracker?.(runHookSilently(...))`
        // would short-circuit optional-call semantics and never evaluate
        // the argument (never fire the hook at all) when hookTracker is
        // undefined.
        // COR-716: a snapshot copy, not the live conversation. The hook runs
        // after the binding derivation and before the call, and it is
        // read-only by contract; handing it the live object would open a
        // mutation window no derivation covers. Writes land in the copy and
        // never reach the request.
        const inputSnapshot = new Conversation(generateContext.conversation.current);
        const onLLMInputHookPromise = runHookSilently(hooks, 'onLLMInput', {
          conversation: inputSnapshot,
          step: generateContext.step,
          messageCount: inputSnapshot.getMessages().length,
        });
        hookTracker?.(onLLMInputHookPromise);

        // COR-581: seal the effective-context epoch here, and nowhere
        // else. This is the last point at which nothing further can change
        // the request — the prepareStep hook waterfall above has run
        // (identity, memory, guardrails), `beforeGenerate` has run, and
        // the short-circuit path that would skip the provider call
        // entirely has already returned. Sealing earlier would produce an
        // epoch that omits sources the model genuinely saw.
        //
        // Inside the retry loop deliberately: a guardrail that sanitizes
        // the user message between attempts changed what the model sees,
        // so the next attempt seals its own epoch.
        const sealedEpoch = deps.contextEpoch?.seal({
          conversation: generateContext.conversation,
          steering: steeringDesiredState,
          plan: deps.selection?.getPlan(),
          toolNames: generateContext.toolbox.tools().map((tool) => tool.name),
          consumer: { runId: deps.runId, step, attempt: stepRetryCount },
        });

        // AB-68: record the configuration this call is issued under. Read
        // from the gate rather than re-planning — `prepareStep` already
        // revalidated it at this step's boundary, so `getPlan()` returns
        // the exact plan this step acted on.
        emitter?.dispatch(
          new GenerateStartedEvent(
            step,
            composeGenerationSelectionRecord(deps.selection?.getPlan(), steeringDesiredState),
            sealedEpoch?.epochId,
          ),
        );
        const generateStart = deps.runtime.monotonic.now();
        let durationMilliseconds: number;
        // COR-581: a provider-level retry whose mutator changed the
        // request seals a successor epoch, referenced from
        // `generate.retry`. Without this the mutation would be invisible —
        // the seal above happens once, before the call, and a mutated
        // retry sends the model something the epoch does not describe.
        // COR-716: a retry mutator returns a new request, so its media is
        // derived again before the retry is issued; `resolvedSources` is never
        // carried across a mutation. A refusal propagates as a
        // `MediaAdmissionError`, handled below as the policy error it is.
        const admitMutated = async (mutatedContext: GenerateContext): Promise<GenerateContext> => {
          const derived = await admission.derive(mutatedContext.conversation);
          return { ...mutatedContext, resolvedSources: derived.resolvedSources };
        };
        const sealMutatedEpoch =
          deps.contextEpoch === undefined
            ? undefined
            : (mutatedContext: GenerateContext, providerAttempt: number): string =>
                deps.contextEpoch!.seal({
                  conversation: mutatedContext.conversation,
                  steering: steeringDesiredState,
                  plan: deps.selection?.getPlan(),
                  toolNames: mutatedContext.toolbox.tools().map((tool) => tool.name),
                  consumer: {
                    runId: deps.runId,
                    step,
                    // Offset past the error-recovery attempt index so a
                    // provider retry and an error-recovery retry of the
                    // same step are never reported as the same attempt.
                    attempt: stepRetryCount + providerAttempt,
                  },
                }).epochId;
        try {
          response =
            deps.parentContext !== undefined && deps.withTraceContext !== undefined
              ? await deps.withTraceContext(deps.parentContext, () =>
                  callGenerateWithRetry(
                    deps.generate,
                    generateContext,
                    deps.retry,
                    emitter,
                    deps.runtime,
                    sealMutatedEpoch,
                    admitMutated,
                  ),
                )
              : await callGenerateWithRetry(
                  deps.generate,
                  generateContext,
                  deps.retry,
                  emitter,
                  deps.runtime,
                  sealMutatedEpoch,
                  admitMutated,
                );
          durationMilliseconds = deps.runtime.monotonic.now() - generateStart;
        } catch (generateError) {
          durationMilliseconds = deps.runtime.monotonic.now() - generateStart;
          emitter?.dispatch(new GenerateErrorEvent(step, generateError, durationMilliseconds));
          throw generateError;
        }

        // COR-713: what `generate` returned, before any hook. A streaming wrapper has already
        // written the step's row (read now, before a hook can replace the response), the
        // provider's dropped-replay-data signal is a provider fact no hook may hide, and every
        // generated media part is admitted as a managed asset here, so no hook, event or row
        // below ever sees inline bytes.
        streamedRowId = streamedRowOf(response, conversation);
        const dropped = readDroppedReplayData(response.metadata);
        if (dropped.length > 0) emitter?.dispatch(new ReplayDataDroppedEvent(step, dropped));
        response = await settleResponse(response, 'generate', { step, admitter });

        // onLLMOutput: parallel allSettled, read-only, non-blocking
        // Use generateContext (which may have been modified by beforeGenerate)
        // for consistency with onLLMInput — both hooks should report the same
        // conversation and step values for a given LLM call. AB-204: handed
        // to hookTracker for the same reason as onLLMInput above (and same
        // "call unconditionally, track separately" reasoning).
        const onLLMOutputHookPromise = runHookSilently(hooks, 'onLLMOutput', {
          conversation: generateContext.conversation,
          step: generateContext.step,
          response: Object.freeze({ ...response }),
          duration: durationMilliseconds,
          usage: response.usage,
        });
        hookTracker?.(onLLMOutputHookPromise);

        // afterGenerate: waterfall that can modify the response.
        // This runs outside the generate try/catch so that hook errors are not
        // misreported as generate errors (the LLM call already succeeded).
        // We iterate handlers manually instead of using hooks.run() because the
        // waterfall pattern in HookRegistry replaces the first argument with the
        // return value. For afterGenerate, the input is AfterGenerateContext but
        // the return is GenerateResponse — using hooks.run() would feed a
        // GenerateResponse where the next handler expects AfterGenerateContext.
        //
        // AB-232: a throwing handler is routed through the same policy
        // `run()` uses — `entry.options.onError`, falling back to the
        // registry-level `onError` exposed via `hooks.onError` — instead of
        // bypassing it, via `applyWaterfallHandlerErrorPolicy` above.
        if (hooks?.has('afterGenerate')) {
          const handlers = hooks.getHandlers('afterGenerate');
          for (const [index, entry] of handlers.entries()) {
            const afterGenContext = {
              conversation,
              step,
              response,
              duration: durationMilliseconds,
            };
            let handlerResult: GenerateResponse | void;
            try {
              // Observed invocation — see the `beforeGenerate` loop above.
              handlerResult = (await hooks.runHandler('afterGenerate', entry, [
                afterGenContext,
              ])) as GenerateResponse | void;
            } catch (error) {
              applyWaterfallHandlerErrorPolicy(
                error,
                'afterGenerate',
                index,
                entry.options,
                hooks.onError,
                entry.id,
              );
              continue;
            }
            if (handlerResult !== undefined) {
              response = handlerResult;
            }
          }
          // COR-713: the response the handlers leave is authoritative; see `settleResponse`.
          response = await settleResponse(response, 'afterGenerate', { step, admitter });
        }

        // AB-302: `GenerateCompletedEvent` is no longer dispatched here — see
        // the post-guardrail dispatch after the retry loop below, which fires
        // once for whichever attempt lands `generateDurationMilliseconds`.
        generateDurationMilliseconds = durationMilliseconds;
      }
      backpressure?.onSuccess();
    } catch (error) {
      // COR-713: a response the loop discards was still billed. Fold its usage in once per thrown
      // error, before any recovery, so a refused or unmapped response never reports zero cost.
      const billedUsage = billedUsageOf(error);
      if (billedUsage !== undefined) {
        accumulateUsage(runState, emitter, step, billedUsage, deps.costEstimation);
      }

      // A tripwire guardrail (mode: 'tripwire') MUST hard-halt the run — it
      // must not be retried, skipped, or otherwise recovered by a user-supplied
      // `onError` hook, which would silently defeat the tripwire. Bypass onError
      // entirely and propagate straight to the error result, matching how the
      // validateResponse tripwire path (below) never consults onError either.
      if (error instanceof GuardrailTripwireError) {
        backpressure?.onError(error);
        emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
        return { kind: 'error', error, errorKind: 'policy' };
      }

      // COR-716: a refusal of the media a retry mutator left behind is
      // admission's verdict, the same policy error the boundary returns, and
      // not something `onError` may recover from.
      if (error instanceof MediaAdmissionError) {
        backpressure?.onError(error);
        emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
        return { kind: 'error', error, errorKind: 'policy' };
      }

      // COR-713: a refused generated-media admission and a parts mismatch are policy and contract
      // verdicts, the same as a media-admission refusal: not something `onError` may recover. A
      // cancellation that interrupted an admission is the cancellation, not a verdict.
      if (
        error instanceof GeneratedMediaNotAdmittedError ||
        error instanceof ResponsePartsMismatchError
      ) {
        backpressure?.onError(error);
        if (signal?.aborted) {
          return { kind: 'abort', reason: explicitAbortReason(signal) };
        }
        emitter?.dispatch(new RunErrorEvent(step, error, error.kind));
        return { kind: 'error', error, errorKind: error.kind };
      }

      // onError recovery: sequential, first non-void return wins.
      // We always invoke the hook regardless of retry count so it can
      // return 'skip' or 'abort' even after retries are exhausted.
      // We iterate handlers manually instead of using hooks.run() because
      // the waterfall pattern replaces the first argument with the return
      // value. For onError, the input is ErrorContext but the return is
      // ErrorRecoveryAction (a string) — using hooks.run() would feed a
      // string where the next handler expects ErrorContext.
      // The hook invocation is wrapped in try/catch so that a throwing
      // onError handler doesn't bypass the error result path — if the
      // hook itself fails, we fall through to normal error propagation
      // using the original error.
      if (hooks?.has('onError')) {
        try {
          const errorContext = {
            error,
            step,
            phase: 'generate' as const,
            conversation,
            retryCount: stepRetryCount,
            maxRetries: deps.maxErrorRetries,
          };
          let errorAction: ErrorRecoveryAction | undefined;
          const handlers = hooks.getHandlers('onError');
          for (const entry of handlers) {
            // Observed invocation — see the `beforeGenerate` loop above.
            const result = (await hooks.runHandler('onError', entry, [errorContext])) as
              ErrorRecoveryAction | undefined;
            if (result !== undefined) {
              errorAction = result;
              break; // first non-void return wins
            }
          }

          if (errorAction === 'retry' && stepRetryCount < deps.maxErrorRetries) {
            stepRetryCount++;
            shouldRetryStep = true;
            continue;
          }

          if (errorAction === 'skip') {
            // Skip this step entirely and continue to the next one
            stepSkipped = true;
            backpressure?.onSuccess();
            break;
          }

          // 'abort' or void — let error propagate normally
        } catch {
          // The onError hook itself threw — fall through to normal error
          // propagation using the original error so that makeErrorResult,
          // onRunError, and RunErrorEvent all fire as expected.
        }
      }

      backpressure?.onError(error);
      if (signal?.aborted) {
        return { kind: 'abort', reason: explicitAbortReason(signal) };
      }
      emitter?.dispatch(new RunErrorEvent(step, error, 'generate'));
      return { kind: 'error', error, errorKind: 'generate' };
    }
  } while (shouldRetryStep);

  return { response, streamedRowId, stepSkipped, generateDurationMilliseconds };
}

/**
 * The id of the row a generate function already committed, if it says it did: the row id it
 * returned, or the conversation's last assistant row for a function that set `messageAppended`
 * without naming it.
 */
function streamedRowOf(response: GenerateResponse, conversation: Conversation): string | undefined {
  if (!response.messageAppended) return undefined;
  if (response.messageId !== undefined) return response.messageId;
  const last = conversation.getMessages().at(-1);
  return last?.role === 'assistant' ? last.id : undefined;
}

/** The usage a thrown error carries for a response that was received and then discarded. */
function billedUsageOf(error: unknown): GenerateResponse['usage'] {
  if (
    error instanceof GeneratedMediaNotAdmittedError ||
    error instanceof ResponsePartsMismatchError ||
    isProviderContractError(error)
  ) {
    return error.usage;
  }
  return undefined;
}
