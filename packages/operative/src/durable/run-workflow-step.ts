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
   * COR-1476 — the session inputs this step's boundary received, in admission
   * order, each already appended to the conversation above. Absent when the run
   * has no {@link SessionInputGate} or nothing was pending, so a step that
   * delivers nothing records exactly what it always did.
   */
  sessionInputDeliveries?: readonly SessionInputDelivery[] | undefined;
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
    const runState = createRunState();
    runState.totalUsage = { ...carriedAccumulators.totalUsage };
    runState.cost = carriedAccumulators.cost ? { ...carriedAccumulators.cost } : undefined;
    runState.lastContent = carriedAccumulators.lastContent;
    runState.schemaAttempts = carriedAccumulators.schemaAttempts;
    runState.lastAppliedConfigVersion = carriedAccumulators.lastAppliedConfigVersion;
    const outcome = await runStep(stepDeps, runState, conversation, stepIndex, deps.emitter);
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
 * {@link SessionInputGate} what was admitted and appends each payload to the
 * conversation as a user message, in the order the gate returns them, before
 * the step generates, so the model sees them on this very step. An input the
 * gate reports as already delivered is not appended again; it is only handed
 * back for settlement.
 *
 * Runs inside the step's memo, so the appended messages and the list of what
 * was delivered are checkpointed together: a replay reads the recorded result
 * and never asks the gate again.
 */
async function deliverSessionInputs(
  deps: DurableRunDeps,
  conversation: Conversation,
  stepIndex: number,
): Promise<readonly SessionInputDelivery[]> {
  const gate = deps.options.sessionInput;
  if (gate === undefined) return [];
  const deliveries: SessionInputDelivery[] = [];
  for (const input of await gate.claimPending()) {
    if (input.delivered) {
      deliveries.push({ id: input.id, providerTurn: stepIndex });
      continue;
    }
    conversation.appendUserMessage(toMessageContent(input.payload), {
      sessionInputId: input.id,
    });
    const message = conversation.getMessages().at(-1);
    if (message === undefined) {
      throw new Error(`Session input "${input.id}" was appended but no message was recorded.`);
    }
    deliveries.push({ id: input.id, conversationMessageId: message.id, providerTurn: stepIndex });
  }
  return deliveries;
}
