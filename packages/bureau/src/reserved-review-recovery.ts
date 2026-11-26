import type { RuntimeServices } from '@lostgradient/lifecycle';
import type {
  AgentSession,
  CheckpointStore,
  SessionStore,
  SessionSummary,
} from '@lostgradient/operative';
import type { RegistryAgnosticEngine } from '@lostgradient/weft';
import { Conversation, createConversationHistory } from 'conversationalist';
import { appendConversationMessages } from './provider-resolution.ts';
import { BureauError } from './bureau-errors.ts';

export function reservedStartCapability(
  durable: { engine: RegistryAgnosticEngine } | undefined,
  ownership: { ownership?: string | undefined } | undefined,
) {
  const engine = durable?.engine;
  const reservedStartsSupported = engine !== undefined && ownership?.ownership !== 'none';
  return {
    reservedStartsSupported,
    async reserveStartClaim(runId: string) {
      if (!reservedStartsSupported || !engine)
        throw new BureauError(
          'Reserved starts require durable workflow-lease ownership',
          'CONFLICT',
        );
      return engine.reserveStartClaim(runId);
    },
  };
}

export async function recoveredReservedSessionOrListed(
  listed: SessionSummary,
  store: SessionStore,
  engine: RegistryAgnosticEngine,
  checkpoints: CheckpointStore,
  runtime: RuntimeServices,
): Promise<AgentSession | SessionSummary> {
  return (
    (await recoverReservedReviewSession(listed, store, engine, checkpoints, runtime)) ?? listed
  );
}

/** Repair a reserved run whose approval and transcript committed before its terminal session save. */
async function recoverReservedReviewSession(
  listed: SessionSummary,
  store: SessionStore,
  engine: RegistryAgnosticEngine,
  checkpoints: CheckpointStore,
  runtime: RuntimeServices,
): Promise<AgentSession | undefined> {
  const runId = listed.metadata['lastRunId'];
  if (
    typeof runId !== 'string' ||
    listed.metadata['lastRunStatus'] !== 'running' ||
    listed.metadata['reservedStartRunId'] !== runId
  )
    return undefined;
  const overrides = listed.metadata['pendingApprovalOverrides'];
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    !Object.keys(overrides).some((id) => id.startsWith(`approval:${runId}:`))
  )
    return undefined;
  const original = await store.load(listed.id);
  if (!original) return undefined;
  const workflow = await engine.get(runId);
  if (
    !workflow ||
    workflow.status !== 'completed' ||
    workflow.type !== 'agentRun' ||
    !workflow.input ||
    typeof workflow.input !== 'object' ||
    !Object.hasOwn(workflow.input, 'sessionId') ||
    !Object.hasOwn(workflow.input, 'runId') ||
    (workflow.input as { sessionId?: unknown }).sessionId !== listed.id ||
    (workflow.input as { runId?: unknown }).runId !== runId
  )
    return undefined;
  const snapshot = await checkpoints.loadConversation(runId, { strict: true });
  if (!snapshot) return undefined;
  const conversationHistory = Conversation.from(snapshot, { runtime }).current;
  const update = () =>
    store.update(listed.id, (session) => {
      if (
        !session ||
        session.incarnation !== original.incarnation ||
        session.metadata['lastRunId'] !== runId ||
        session.metadata['reservedStartRunId'] !== runId ||
        session.metadata['lastRunStatus'] !== 'running' ||
        JSON.stringify(session.metadata['pendingApprovalOverrides']) !== JSON.stringify(overrides)
      )
        return undefined;
      return {
        ...session,
        conversationHistory: appendConversationMessages(
          session.conversationHistory,
          conversationHistory,
          createConversationHistory({ id: session.id }),
        ),
        metadata: { ...session.metadata, lastRunStatus: 'completed' },
      };
    });
  try {
    const restored = await update();
    if (restored) return restored;
  } catch (error) {
    const recorded = await store.load(listed.id);
    if (
      recorded &&
      recorded.incarnation === original.incarnation &&
      recorded.metadata['lastRunId'] === runId &&
      recorded.metadata['lastRunStatus'] === 'completed' &&
      JSON.stringify(recorded.metadata['pendingApprovalOverrides']) === JSON.stringify(overrides) &&
      conversationHistory.ids.every((id) => recorded.conversationHistory.ids.includes(id))
    )
      return recorded;
    throw error;
  }
  const recorded = await store.load(listed.id);
  return recorded &&
    recorded.incarnation === original.incarnation &&
    recorded.metadata['lastRunId'] === runId &&
    recorded.metadata['lastRunStatus'] === 'completed' &&
    JSON.stringify(recorded.metadata['pendingApprovalOverrides']) === JSON.stringify(overrides) &&
    conversationHistory.ids.every((id) => recorded.conversationHistory.ids.includes(id))
    ? recorded
    : undefined;
}
