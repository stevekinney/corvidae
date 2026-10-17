import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { WorkflowContext, WorkflowOperation } from '@lostgradient/weft';
import { Conversation, type MultiModalContent } from 'conversationalist';

import { toAgentRunError } from '../errors';
import { buildStepDeps, createRunState } from '../loop';
import { runStep } from '../run-step';
import type { FinishReason, StepResult } from '../types';
import { runDepsFrom } from './run-workflow-input';
import {
  classifyErrorFinishReason,
  serializeError,
  tripwireDetailFrom,
} from './run-workflow-result';
import {
  applyConversationSnapshotDelta,
  type ConversationSnapshotDelta,
  diffConversationSnapshot,
} from './snapshot-delta';
import type {
  DurableRunDeps,
  PendingHumanWait,
  PendingWakeup,
  RunCursor,
  SessionInputDelivery,
  SessionInputPayload,
  StepRecord,
} from './types';

type ConversationSnapshot = ReturnType<Conversation['snapshot']>;

/**
 * The conversation each run's latest step left behind, keyed by that run's
 * in-process deps (`ctx.services`). The workflow carries only the snapshot
 * across steps, and restoring it rebuilds every history node, so a run that
 * restored on every step grew with the cube of its length. A step reuses the
 * previous step's conversation when the snapshot it is handed is the one that
 * conversation produced and nothing has changed it since; anything else, such
 * as a fresh process resuming from its checkpoint (which builds new deps), falls
 * back to a full restore. The non-durable loop likewise runs every step on one
 * conversation.
 */
const liveConversations = new WeakMap<
  DurableRunDeps,
  { readonly conversation: Conversation; readonly digest: string }
>();

function conversationForStep(deps: DurableRunDeps, snapshot: ConversationSnapshot): Conversation {
  const live = liveConversations.get(deps);
  if (
    live !== undefined &&
    live.digest === snapshot.integrity.digest &&
    live.conversation.revision === snapshot.controllerRevision
  ) {
    return live.conversation;
  }
  return Conversation.from(snapshot, {
    runtime: deps.options.runtime ?? createDefaultRuntimeServices(),
  });
}

function snapshotAfterStep(deps: DurableRunDeps, conversation: Conversation): ConversationSnapshot {
  const snapshot = conversation.snapshot();
  liveConversations.set(deps, { conversation, digest: snapshot.integrity.digest });
  return snapshot;
}

export interface DurableStepMemoResult {
  outcome: Pick<Awaited<ReturnType<typeof runStep>>, 'kind'>;
  errorMessage?: string | undefined;
  errorFinishReason?: FinishReason | undefined;
  errorKind?: ReturnType<typeof toAgentRunError>['kind'] | undefined;
  errorCode?: ReturnType<typeof toAgentRunError>['code'] | undefined;
  tripwire?: ReturnType<typeof tripwireDetailFrom> | undefined;
  abortReason?: string | undefined;
  stopFinishReason?: FinishReason | undefined;
  schemaValidation?: { success: boolean; error?: string } | undefined;
  output?: unknown;
  record: StepRecord | null;
  /**
   * The conversation after the step, whole. Exactly one of this and
   * {@link DurableStepMemoResult.conversationDelta} is set; read either through
   * {@link conversationAfterStep}.
   */
  conversationSnapshot?: ConversationSnapshot | undefined;
  /** COR-1376 — the conversation after the step, as a delta from the step's input snapshot. */
  conversationDelta?: ConversationSnapshotDelta | undefined;
  nextAccumulators: Pick<
    RunCursor,
    'totalUsage' | 'cost' | 'lastContent' | 'schemaAttempts' | 'lastAppliedConfigVersion'
  >;
  pendingWakeup?: PendingWakeup | undefined;
  pendingHumanWait?: PendingHumanWait | undefined;
  /**
   * COR-1476 — the session inputs this step's boundary received before it
   * generated, in admission order, each already appended to the conversation
   * above. This step's generation is their answer, so the workflow promotes them
   * only if the step succeeds. Absent when the run has no
   * {@link SessionInputGate} or nothing was pending, so a step that delivers
   * nothing records exactly what it always did.
   */
  sessionInputDeliveries?: readonly SessionInputDelivery[] | undefined;
  /**
   * COR-1476 — the session inputs drained after this step generated, because it
   * would have ended the run. They are appended, but the NEXT step answers them,
   * so the workflow carries them until that step succeeds.
   */
  lateSessionInputDeliveries?: readonly SessionInputDelivery[] | undefined;
}

/** Options for {@link runStepMemo}. */
export interface RunStepMemoOptions {
  /**
   * COR-1376 — record the conversation as a delta from `snapshot` rather than
   * whole. Only pass `true` when `snapshot` is itself rebuilt from recorded
   * results on every replay (the previous step's output), never for a snapshot
   * the workflow body built outside a memo, such as the seeded conversation or
   * a continuation message, whose ids and timestamps change on replay.
   */
  readonly delta?: boolean;
  /**
   * COR-1476 — the run's step cap. A step that would end the run asks the
   * session input gate once more only while a step remains for the answer:
   * input never extends a run past its budget, and what is left waits for the
   * session's continuation run.
   */
  readonly maximumSteps?: number | undefined;
}

/**
 * The conversation a step memo result leaves behind, given the snapshot the
 * step started from.
 */
export function conversationAfterStep(
  snapshot: ConversationSnapshot,
  result: Pick<DurableStepMemoResult, 'conversationSnapshot' | 'conversationDelta'>,
): ConversationSnapshot {
  if (result.conversationSnapshot !== undefined) return result.conversationSnapshot;
  if (result.conversationDelta !== undefined) {
    return applyConversationSnapshotDelta(snapshot, result.conversationDelta);
  }
  throw new Error('Durable step result carries no conversation.');
}

export function runStepMemo(
  ctx: Pick<WorkflowContext, 'services' | 'memo'>,
  snapshot: ConversationSnapshot,
  stepIndex: number,
  carriedAccumulators: DurableStepMemoResult['nextAccumulators'],
  runId: string,
  options: RunStepMemoOptions = {},
): WorkflowOperation<DurableStepMemoResult> {
  return ctx.memo(`step-${stepIndex}`, async () => {
    const deps = runDepsFrom(ctx.services);
    deps.pendingHumanWait = undefined;
    deps.pendingWakeup = undefined;
    const conversation = conversationForStep(deps, snapshot);
    const stepDeps = {
      ...buildStepDeps(deps.options),
      toolbox: deps.toolbox,
      onStepToolbox: deps.onStepToolbox,
      runId,
      durableOperationKeys: true,
    };
    const sessionInputDeliveries = await deliverSessionInputs(deps, conversation, stepIndex);
    const canAnswerLateInput =
      options.maximumSteps === undefined || stepIndex + 1 < options.maximumSteps;
    // COR-1476 — a continuation run has no prompt of its own, so with nothing
    // delivered and nothing waiting for an answer there is nothing to generate:
    // it ends without a model call.
    if (
      deps.options.continuation === true &&
      stepIndex === 0 &&
      sessionInputDeliveries.length === 0 &&
      !endsWithUnansweredUserTurn(conversation)
    ) {
      const unchanged = snapshotAfterStep(deps, conversation);
      return {
        outcome: { kind: 'stop' },
        stopFinishReason: 'stop-condition',
        record: null,
        ...(options.delta === true
          ? { conversationDelta: diffConversationSnapshot(snapshot, unchanged) }
          : { conversationSnapshot: unchanged }),
        nextAccumulators: carriedAccumulators,
      };
    }
    const lateSessionInputDeliveries: SessionInputDelivery[] = [];
    const runState = createRunState();
    runState.totalUsage = { ...carriedAccumulators.totalUsage };
    runState.cost = carriedAccumulators.cost ? { ...carriedAccumulators.cost } : undefined;
    runState.lastContent = carriedAccumulators.lastContent;
    runState.schemaAttempts = carriedAccumulators.schemaAttempts;
    runState.lastAppliedConfigVersion = carriedAccumulators.lastAppliedConfigVersion;
    let outcome = await runStep(stepDeps, runState, conversation, stepIndex, deps.emitter);
    // COR-1476 — input admitted while this step generated would otherwise wait
    // for a boundary that never comes, because the step ends the run. Ask the
    // gate once more: pending input turns the stop into a continue, as a failed
    // schema validation does, so the same run answers it, after the reply it
    // arrived during and in the order admitted.
    if (outcome.kind === 'stop' && canAnswerLateInput) {
      const late = await deliverSessionInputs(deps, conversation, stepIndex + 1);
      if (late.length > 0) {
        lateSessionInputDeliveries.push(...late);
        const stopped = runState.steps.at(-1);
        if (stopped !== undefined) stopped.final = false;
        outcome = { kind: 'continue' };
      }
    }
    deps.onStepToolbox?.(deps.toolbox);
    const pushed: StepResult | undefined = runState.steps.at(-1);
    const stepMetadata = pushed ? { ...pushed.metadata, ...deps.getStepMetadata?.() } : undefined;
    const record: StepRecord | null = pushed
      ? {
          step: pushed.step,
          content: pushed.content,
          toolCalls: pushed.toolCalls,
          results: pushed.results,
          ...(pushed.usage ? { usage: pushed.usage } : {}),
          ...(stepMetadata && Object.keys(stepMetadata).length > 0
            ? { metadata: stepMetadata }
            : {}),
          final: pushed.final,
        }
      : null;
    const nextSnapshot = snapshotAfterStep(deps, conversation);
    const normalizedError =
      outcome.kind === 'error'
        ? toAgentRunError(outcome.error, { kind: outcome.errorKind })
        : undefined;
    return {
      outcome: { kind: outcome.kind },
      errorMessage: outcome.kind === 'error' ? serializeError(outcome.error) : undefined,
      errorFinishReason:
        outcome.kind === 'error' ? classifyErrorFinishReason(outcome.error) : undefined,
      errorKind: normalizedError?.kind,
      errorCode: normalizedError?.code,
      tripwire: outcome.kind === 'error' ? tripwireDetailFrom(outcome.error) : undefined,
      abortReason: outcome.kind === 'abort' ? outcome.reason : undefined,
      stopFinishReason: outcome.kind === 'stop' ? outcome.finishReason : undefined,
      schemaValidation:
        outcome.kind === 'stop' && outcome.schemaValidation
          ? {
              success: outcome.schemaValidation.success,
              ...(outcome.schemaValidation.error !== undefined
                ? { error: serializeError(outcome.schemaValidation.error) }
                : {}),
            }
          : undefined,
      output: outcome.kind === 'stop' ? outcome.output : undefined,
      record,
      ...(options.delta === true
        ? { conversationDelta: diffConversationSnapshot(snapshot, nextSnapshot) }
        : { conversationSnapshot: nextSnapshot }),
      nextAccumulators: {
        totalUsage: runState.totalUsage,
        cost: runState.cost,
        lastContent: runState.lastContent,
        schemaAttempts: runState.schemaAttempts,
        lastAppliedConfigVersion: runState.lastAppliedConfigVersion,
      },
      pendingWakeup: deps.pendingWakeup,
      pendingHumanWait: deps.pendingHumanWait,
      ...(sessionInputDeliveries.length > 0 ? { sessionInputDeliveries } : {}),
      ...(lateSessionInputDeliveries.length > 0 ? { lateSessionInputDeliveries } : {}),
    };
  });
}

/**
 * A session-input payload as message content. Admission keeps `citations` off
 * text parts structurally (`citations?: undefined`); the conversation's own
 * text part omits the key rather than holding `undefined`, so drop it here.
 */
function toMessageContent(payload: SessionInputPayload): string | MultiModalContent[] {
  if (typeof payload === 'string') return payload;
  return payload.map((part): MultiModalContent => {
    if (part.type !== 'text') return part;
    const { citations: _unusedCitations, ...text } = part;
    return text;
  });
}

/** Whether the conversation ends with a user turn nothing has answered. */
function endsWithUnansweredUserTurn(conversation: Conversation): boolean {
  return conversation.getMessages().at(-1)?.role === 'user';
}

/**
 * COR-1476 — the step boundary's session-input delivery. Asks the run's
 * {@link SessionInputGate} what is pending and appends each payload to the
 * conversation as a user message, in the order the gate returns them, so the
 * model sees them on the step that follows.
 *
 * Delivery is idempotent per command: an input whose user turn is already in the
 * conversation (a lease that lapsed under a live step and was claimed again, or a
 * transcript an earlier run saved with the turn but no answer) is not appended a
 * second time; its existing turn is what is promoted once it is answered.
 *
 * Runs inside the step's memo, so the appended messages and the list of what
 * was delivered are checkpointed together: a replay reads the recorded result
 * and never asks the gate again. `providerTurn` is the step whose generation
 * answers the inputs.
 */
async function deliverSessionInputs(
  deps: DurableRunDeps,
  conversation: Conversation,
  providerTurn: number,
): Promise<SessionInputDelivery[]> {
  const gate = deps.options.sessionInput;
  if (gate === undefined) return [];
  const sessionId = deps.options.sessionId;
  if (sessionId === undefined) {
    throw new Error('A run with a session input gate must belong to a session.');
  }
  const deliveries: SessionInputDelivery[] = [];
  for (const input of await gate.claimPending()) {
    const existing = conversation
      .getMessages()
      .find((message) => message.metadata?.['sessionInputCommandId'] === input.commandId);
    let messageId = existing?.id;
    if (messageId === undefined) {
      conversation.appendUserMessage(toMessageContent(input.payload), {
        sessionInputId: input.id,
        sessionInputCommandId: input.commandId,
      });
      messageId = conversation.getMessages().at(-1)?.id;
    }
    if (messageId === undefined) {
      throw new Error(`Session input "${input.id}" was appended but no message was recorded.`);
    }
    deliveries.push({
      id: input.id,
      commandId: input.commandId,
      sessionId,
      deliveredAt: (deps.options.runtime ?? createDefaultRuntimeServices()).clock.nowISO(),
      conversationMessageId: messageId,
      providerTurn,
    });
  }
  return deliveries;
}
