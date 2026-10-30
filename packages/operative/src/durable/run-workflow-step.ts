import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { WorkflowContext, WorkflowOperation } from '@lostgradient/weft';
import { Conversation, type MessageInput, type MultiModalContent } from 'conversationalist';

import { effectiveContextTail } from '../effective-context-record';
import { toAgentRunError } from '../errors';
import { buildStepDeps, createRunState } from '../loop';
import { runStep } from '../run-step';
import type { FinishReason, StepResult } from '../types';
import { CHECKPOINT_RECORD_SCHEMA_VERSION } from './checkpoint-version';
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
    | 'totalUsage'
    | 'cost'
    | 'lastContent'
    | 'lastParts'
    | 'finalRowIsReplacement'
    | 'schemaAttempts'
    | 'lastAppliedConfigVersion'
    | 'effectiveContextTail'
  >;
  pendingWakeup?: PendingWakeup | undefined;
  pendingHumanWait?: PendingHumanWait | undefined;
  /**
   * COR-1476 — the session inputs this step's boundary received before it
   * generated, in admission order, each already appended to the conversation
   * above. The workflow promotes them in the same checkpoint write as this
   * step's transcript, whatever the step's outcome. Absent when the run has no
   * {@link SessionInputGate} or nothing was pending, so a step that delivers
   * nothing records exactly what it always did.
   */
  sessionInputDeliveries?: readonly SessionInputDelivery[] | undefined;
  /**
   * COR-1476 — the session inputs drained after this step generated, because it
   * would have ended the run. They are appended and promoted with this step's
   * transcript too; the NEXT step answers them.
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
   * input never extends a run past its budget, and what is left is cancelled
   * when the run ends, for the client to resend.
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
      admissionTracker: deps.admissionTracker,
      runId,
      durableOperationKeys: true,
    };
    const sessionInputDeliveries = await deliverSessionInputs(deps, conversation, stepIndex);
    const canAnswerLateInput =
      options.maximumSteps === undefined || stepIndex + 1 < options.maximumSteps;
    const lateSessionInputDeliveries: SessionInputDelivery[] = [];
    const runState = createRunState();
    runState.totalUsage = { ...carriedAccumulators.totalUsage };
    runState.cost = carriedAccumulators.cost ? { ...carriedAccumulators.cost } : undefined;
    runState.lastContent = carriedAccumulators.lastContent;
    runState.lastParts = carriedAccumulators.lastParts;
    runState.finalRowIsReplacement = carriedAccumulators.finalRowIsReplacement;
    runState.schemaAttempts = carriedAccumulators.schemaAttempts;
    runState.lastAppliedConfigVersion = carriedAccumulators.lastAppliedConfigVersion;
    runState.effectiveContextTail = carriedAccumulators.effectiveContextTail;
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
    // COR-1810: the stored form of the record the step reports, a delta from the previous stored
    // step's conversation when this one extends it.
    const storedContext =
      pushed?.effectiveContext === undefined ? undefined : runState.storedEffectiveContext;
    const nextContextTail =
      storedContext === undefined
        ? carriedAccumulators.effectiveContextTail
        : effectiveContextTail(storedContext);
    const record: StepRecord | null = pushed
      ? {
          schemaVersion: CHECKPOINT_RECORD_SCHEMA_VERSION,
          step: pushed.step,
          content: pushed.content,
          parts: pushed.parts,
          ...(pushed.messageId === undefined ? {} : { messageId: pushed.messageId }),
          ...(pushed.contextEpochId === undefined ? {} : { contextEpochId: pushed.contextEpochId }),
          ...(pushed.planReason === undefined ? {} : { planReason: pushed.planReason }),
          ...(storedContext === undefined ? {} : { effectiveContext: storedContext }),
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
        lastParts: runState.lastParts,
        finalRowIsReplacement: runState.finalRowIsReplacement,
        schemaAttempts: runState.schemaAttempts,
        lastAppliedConfigVersion: runState.lastAppliedConfigVersion,
        ...(nextContextTail === undefined ? {} : { effectiveContextTail: nextContextTail }),
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

/**
 * COR-1476 — the step boundary's session-input delivery. Asks the run's
 * {@link SessionInputGate} what is pending and appends each payload to the
 * conversation as a user message, in the order the gate returns them, so the
 * model sees them on the step that follows.
 *
 * The appended message's id is the input's own `id`, so a client can find its
 * turn in the run's history by the id it submitted. The one exception is an id
 * the conversation already holds a message for: a caller may reuse an input id
 * once the mailbox has retired the earlier record, and a conversation refuses a
 * duplicate message id, so that turn gets a fresh id rather than failing the
 * step. Its `sessionInputId` metadata still names the input.
 *
 * Delivery is idempotent per command: an input whose user turn is already in the
 * conversation (keyed by its mailbox command, which, unlike the input id, names
 * exactly one admission) is not appended a second time.
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
  const { options } = deps;
  // A gate comes paired with its session id (`RunOptions`), so the narrowing
  // on the gate is what makes the id definite below.
  if (options.sessionInput === undefined) return [];
  const { sessionId, sessionInput: gate } = options;
  const deliveries: SessionInputDelivery[] = [];
  for (const input of await gate.claimPending()) {
    // Hidden messages count: a hidden turn still holds its command and its id.
    const messages = conversation.getMessages({ includeHidden: true });
    const existing = messages.find(
      (message) => message.metadata?.['sessionInputCommandId'] === input.commandId,
    );
    let messageId = existing?.id;
    if (messageId === undefined) {
      const metadata = { sessionInputId: input.id, sessionInputCommandId: input.commandId };
      const idIsFree = !messages.some((message) => message.id === input.id);
      const turn: MessageInput & { readonly id?: string } = {
        role: 'user',
        content: toMessageContent(input.payload),
        metadata,
        ...(idIsFree ? { id: input.id } : {}),
      };
      conversation.appendMessages(turn);
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
