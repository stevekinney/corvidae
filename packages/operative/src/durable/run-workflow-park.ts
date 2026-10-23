import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { NormalizeActivities, WorkflowContext, WorkflowOperation } from '@lostgradient/weft';
import { Conversation, withMessageId } from 'conversationalist';

import { isFailureFinishReason } from '../finish-reason';
import { signalMessageIdentifier } from '../message-identifiers';
import type { FinishReason } from '../types';
import {
  buildSignalContinuationInput,
  buildWakeupContinuationInput,
  renderSignalContinuation,
  renderWakeupContinuation,
} from './continuation-input';
import { HUMAN_WAIT_PARKED_LOG_MARKER } from './human-wait-park-marker';
import { runDepsFrom } from './run-workflow-input';
import type { createStorageActivities } from './storage-activities';
import type { PendingHumanWait, PendingWakeup, RunCursor } from './types';

export type WorkflowParkContext = Pick<
  WorkflowContext<NormalizeActivities<ReturnType<typeof createStorageActivities>>>,
  'services' | 'sleep' | 'waitForSignal' | 'memo' | 'run' | 'log'
>;

export interface WorkflowParkState {
  snapshot: ReturnType<Conversation['snapshot']>;
  cursor: RunCursor;
  /** The reason the loop ended with, or `undefined` when it broke out to park (COR-1627). */
  finishReason: FinishReason | undefined;
  errorMessage?: string | undefined;
  abortReason?: string | undefined;
  schemaValidation?: { success: boolean; error?: string | undefined } | undefined;
  output?: unknown;
  tripwire?:
    | {
        guardrailName: string;
        category: string;
        phase: 'input' | 'output';
        confidence: number;
        detail?: string;
      }
    | undefined;
  stoppedEarly: boolean;
  pendingWakeup?: PendingWakeup | undefined;
  pendingHumanWait?: PendingHumanWait | undefined;
  lastWakeupNote?: string | undefined;
  lastHumanWaitSignal?: string | undefined;
  /** The run's ordinal of the pending human-wait park (see `human-wait-parks.ts`). */
  humanWaitParkOrdinal?: number | undefined;
  /**
   * Set when the step that parked also left a tool call waiting on approval. That step
   * stopped the run on the approval, and the park only holds the run until the human
   * has answered: once the answer is in the conversation the run settles, as it would
   * have without the park, so the approval is the next thing it offers and the run does
   * not generate past it.
   */
  settleAfterAnswer?: boolean | undefined;
  runId: string;
}

export function* runWorkflowPark(
  ctx: WorkflowParkContext,
  state: WorkflowParkState,
): WorkflowOperation<boolean> {
  // A loop that broke out to park carries no finish reason yet. One that ended in a failure, by
  // the one predicate (COR-1627), or in an abort, which is not a failure but still ends the run,
  // does not park: the request its step registered is left unfired. A stop parks and continues.
  const isFailureOutcome =
    state.finishReason !== undefined &&
    (isFailureFinishReason(state.finishReason) || state.finishReason === 'aborted');

  if (!isFailureOutcome && state.pendingWakeup !== undefined) {
    const requestedDuration = state.pendingWakeup.duration;
    const note = state.pendingWakeup.note;
    yield* ctx.sleep(requestedDuration);
    state.pendingWakeup = undefined;
    state.lastWakeupNote = note;
    const firedAt = yield* ctx.memo(`wakeup-fired-at-${state.cursor.step}`, () =>
      Promise.resolve(
        (
          runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices()
        ).clock.nowISO(),
      ),
    );
    const renderedMessage = renderWakeupContinuation(
      buildWakeupContinuationInput(requestedDuration, note, firedAt),
    );
    state.snapshot = (() => {
      const resumedConversation = Conversation.from(state.snapshot, {
        runtime: runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices(),
      });
      resumedConversation.appendUserMessage(renderedMessage);
      return resumedConversation.snapshot();
    })();
    yield* ctx.run('saveConversation', { runId: state.runId, snapshot: state.snapshot });
    resetTerminalState(state);
    return true;
  }

  if (!isFailureOutcome && state.pendingHumanWait !== undefined) {
    const signalName = state.pendingHumanWait.signalName;
    // COR-121: on a run reattached in this process, replay can hide the
    // `requestHumanInput` tool dispatch. weft suppresses `ctx.log` when this
    // position is cached (a park whose signal was already delivered), so the
    // marker fires only for the pending park.
    const deps = runDepsFrom(ctx.services);
    if (deps.recoveredRun === true && deps.emitter !== undefined) {
      ctx.log?.info(HUMAN_WAIT_PARKED_LOG_MARKER, {
        runId: state.runId,
        signalName,
        prompt: state.pendingHumanWait.prompt,
        inputSchema: state.pendingHumanWait.inputSchema,
        emitter: deps.emitter,
      });
    }
    const payload = yield* ctx.waitForSignal(signalName);
    state.pendingHumanWait = undefined;
    state.lastHumanWaitSignal = signalName;
    const deliveredAt = yield* ctx.memo(`signal-delivered-at-${state.cursor.step}`, () =>
      Promise.resolve(
        (
          runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices()
        ).clock.nowISO(),
      ),
    );
    const renderedMessage = renderSignalContinuation(
      buildSignalContinuationInput(signalName, payload, deliveredAt),
    );
    // The park's ordinal in the run, not a count of the rows the conversation holds,
    // which a compaction can shrink.
    const parkOrdinal = state.humanWaitParkOrdinal;
    state.snapshot = (() => {
      const resumedConversation = Conversation.from(state.snapshot, {
        runtime: runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices(),
      });
      const id =
        parkOrdinal === undefined
          ? undefined
          : signalMessageIdentifier(state.runId, signalName, parkOrdinal);
      if (id === undefined) resumedConversation.appendUserMessage(renderedMessage);
      else
        resumedConversation.appendMessages(
          withMessageId({ role: 'user', content: renderedMessage }, id),
        );
      return resumedConversation.snapshot();
    })();
    yield* ctx.run('saveConversation', { runId: state.runId, snapshot: state.snapshot });
    if (state.settleAfterAnswer === true) {
      // The step already stopped the run on the approval it is waiting for: the
      // answer is part of the conversation the approval's continuation starts from.
      state.settleAfterAnswer = false;
      return false;
    }
    resetTerminalState(state);
    return true;
  }

  return false;
}

function resetTerminalState(state: WorkflowParkState): void {
  state.finishReason = undefined;
  state.errorMessage = undefined;
  state.abortReason = undefined;
  state.schemaValidation = undefined;
  state.output = undefined;
  state.tripwire = undefined;
  state.stoppedEarly = false;
}
