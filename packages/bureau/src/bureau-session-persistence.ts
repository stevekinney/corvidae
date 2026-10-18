import type { AgentSession, JSONValue, SessionStore, Store } from '@lostgradient/operative';
import { createAgentSession } from '@lostgradient/operative';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';

import {
  isPlainAuthorityRecord,
  resolveSessionOwner,
  SESSION_OWNER_METADATA_KEY,
  SessionOwnerConflictError,
} from './session-authority';
import type { DiagnosticSink } from './types';

const BUREAU_AGENT_NAME = 'bureau';
const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;

export interface SessionPersistenceDependencies {
  readonly sessionStore: Pick<SessionStore, 'load' | 'update'> | undefined;
  readonly orphanedRunIds: Set<string>;
  readonly store: Pick<Store, 'getRun'>;
  readonly retryDelayMilliseconds: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly diagnose: DiagnosticSink;
  readonly serializeError: (error: unknown) => string;
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = candidate.messages[id];
    const baseMessage = base.messages[id];
    const message =
      candidateMessage &&
      (!baseMessage || !messagesAreEqual(candidateMessage, baseMessage) || !current.messages[id])
        ? candidateMessage
        : (current.messages[id] ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: { ...current.metadata, ...candidate.metadata },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

function omitKeysWithPrefix(
  record: Record<string, JSONValue>,
  prefix: string,
): Record<string, JSONValue> {
  const remaining: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) remaining[key] = value;
  }
  return remaining;
}

function enumerableRecord(
  value: JSONValue | undefined,
  includeArrays: boolean,
): Record<string, JSONValue> {
  if (isPlainAuthorityRecord(value)) return value;
  if (includeArrays && Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  if (includeArrays && typeof value === 'string') {
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function mergeMetadata(
  current: Record<string, JSONValue>,
  metadata: Record<string, JSONValue>,
): Record<string, JSONValue> {
  // Ownership maps remain durable after a run reaches a terminal state so
  // event-history authorization can resolve retained history. Maintenance,
  // rather than this write path, prunes entries below the retention floor.
  return {
    ...current,
    ...metadata,
    // The session's owner is written once, by the run that created it. A later
    // save, from any run, never replaces it.
    ...(current[SESSION_OWNER_METADATA_KEY] !== undefined
      ? { [SESSION_OWNER_METADATA_KEY]: current[SESSION_OWNER_METADATA_KEY] }
      : {}),
    ...(metadata['lastRequestAuthorities'] !== undefined
      ? {
          lastRequestAuthorities: {
            ...enumerableRecord(current['lastRequestAuthorities'], false),
            ...enumerableRecord(metadata['lastRequestAuthorities'], true),
          },
        }
      : {}),
    ...(metadata['lastRunOwningPrincipals'] !== undefined
      ? {
          lastRunOwningPrincipals: {
            ...enumerableRecord(current['lastRunOwningPrincipals'], false),
            ...enumerableRecord(metadata['lastRunOwningPrincipals'], true),
          },
        }
      : {}),
    // One entry per starting run, so concurrent starts each keep theirs.
    ...(metadata['steeringStartingRuns'] !== undefined
      ? {
          steeringStartingRuns: {
            ...enumerableRecord(current['steeringStartingRuns'], false),
            ...enumerableRecord(metadata['steeringStartingRuns'], true),
          },
        }
      : {}),
  };
}

function clearTerminalApprovalMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  hasPendingApproval: boolean,
): void {
  // A terminal action-required run can still have a live approval review.
  // Retain its authority and approval descriptor until that review resolves.
  if (hasPendingApproval) return;
  if (isPlainAuthorityRecord(metadata['lastRequestAuthorities'])) {
    const { [runId]: _removed, ...remainingAuthorities } = metadata['lastRequestAuthorities'];
    metadata['lastRequestAuthorities'] = remainingAuthorities;
  }
  if (isPlainAuthorityRecord(metadata['pendingApprovalOverrides'])) {
    metadata['pendingApprovalOverrides'] = omitKeysWithPrefix(
      metadata['pendingApprovalOverrides'],
      `approval:${runId}:`,
    );
  }
}

function clearCompletedRunMetadata(
  metadata: Record<string, JSONValue>,
  store: Pick<Store, 'getRun'>,
): void {
  const runId = metadata['lastRunId'];
  const status = metadata['lastRunStatus'];
  if (
    typeof runId !== 'string' ||
    (status !== 'completed' && status !== 'aborted' && status !== 'error')
  ) {
    return;
  }
  const hasPendingApproval = store
    .getRun(runId)
    ?.steps.some((step) =>
      step.results.some(
        (result) => result.outcome === 'action_required' && result.pendingApproval !== undefined,
      ),
    );
  clearTerminalApprovalMetadata(metadata, runId, hasPendingApproval ?? false);
  // An ended run is no longer starting. Copied, never edited in place: the
  // map may still be the stored session's own object.
  const starting = metadata['steeringStartingRuns'];
  if (typeof starting === 'object' && starting !== null && !Array.isArray(starting)) {
    metadata['steeringStartingRuns'] = Object.fromEntries(
      Object.entries(starting).filter(([startingRunId]) => startingRunId !== runId),
    );
  }
}

export function createSessionPersistence(dependencies: SessionPersistenceDependencies) {
  const {
    sessionStore,
    orphanedRunIds,
    store,
    retryDelayMilliseconds,
    sleep,
    diagnose,
    serializeError,
  } = dependencies;

  async function loadConversation(sessionId: string) {
    if (!sessionStore) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    const session = await sessionStore.load(sessionId);
    return {
      session,
      conversation: new Conversation(
        session?.conversationHistory ?? createConversationHistory({ id: sessionId }),
      ),
    };
  }

  async function saveSession(
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory: ConversationHistory = conversation.current,
    // The session incarnation the run was started (or recovered) against.
    // When given, the save applies only to that incarnation: another
    // process may have deleted the session without knowing this run exists,
    // and an upsert here would silently undo that deletion.
    expectedIncarnation?: string,
  ): Promise<AgentSession | undefined> {
    if (!sessionStore) return undefined;
    const candidateRunId = metadata['lastRunId'];
    if (typeof candidateRunId === 'string' && orphanedRunIds.delete(candidateRunId)) {
      return undefined;
    }

    // The session as this save committed it: its incarnation is the one the
    // caller's run now belongs to, whatever replaces it afterwards.
    return sessionStore.update(sessionId, (existingSession: AgentSession | undefined) => {
      if (
        expectedIncarnation !== undefined &&
        existingSession?.incarnation !== expectedIncarnation
      ) {
        return undefined;
      }
      // A save that names an owner (the run that creates or continues the
      // session) must name the one the stored session has: this is decided inside
      // the atomic update, so a racing save cannot append to another owner's session.
      const incomingOwner = metadata[SESSION_OWNER_METADATA_KEY];
      if (
        existingSession !== undefined &&
        typeof incomingOwner === 'string' &&
        resolveSessionOwner(existingSession.metadata) !== incomingOwner
      ) {
        throw new SessionOwnerConflictError(sessionId);
      }
      const nextSession =
        existingSession ??
        createAgentSession({
          id: sessionId,
          agentName: agentName ?? BUREAU_AGENT_NAME,
          conversationHistory: conversation.current,
        });
      // COR-1577 — a session is bound to the agent of the run that created it, so a later save
      // never changes it: `createRun` refuses a run that names another agent before it reaches here.
      const resolvedAgentName = nextSession.agentName;
      const mergedMetadata = mergeMetadata(nextSession.metadata, metadata);
      clearCompletedRunMetadata(mergedMetadata, store);

      return {
        ...nextSession,
        agentName: resolvedAgentName,
        conversationHistory: existingSession
          ? appendConversationMessages(
              existingSession.conversationHistory,
              conversation.current,
              baseConversationHistory,
            )
          : conversation.current,
        metadata: mergedMetadata,
      };
    });
  }

  const inFlight = new Set<Promise<void>>();

  /**
   * Starts a terminal session save without holding up the run's terminal
   * event. The save is tracked so `drain()` can land it before shutdown stops
   * the producers its outbox entry is replayed through.
   */
  function persistSessionUpdate(
    saveSessionUpdate: () => Promise<unknown>,
    context: { runId: string; sessionId: string; status: 'completed' | 'error' | 'aborted' },
  ): Promise<void> {
    const persisting = (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          await saveSessionUpdate();
          return;
        } catch (error) {
          lastError = error;
          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            try {
              await sleep(retryDelayMilliseconds);
            } catch (sleepError) {
              lastError = sleepError;
              break;
            }
          }
        }
      }
      diagnose({
        level: 'error',
        scope: 'session-persistence',
        message: `[bureau] Failed to persist ${context.status} session state for run ${context.runId} in session ${context.sessionId}: ${serializeError(lastError)}`,
      });
    })();
    inFlight.add(persisting);
    void persisting.finally(() => inFlight.delete(persisting));
    // Resolves once the save has landed or been given up on; never rejects.
    return persisting;
  }

  /**
   * Resolves once every terminal session save already started has settled.
   * Only saves are awaited, never the runs that start them, so a run that
   * ignores its abort cannot hold shutdown open.
   */
  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  return { loadConversation, saveSession, persistSessionUpdate, drain };
}
