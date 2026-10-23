import {
  type AgentSession,
  createAgentSession,
  type JSONValue,
  type SessionStore,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createSessionPersistence } from './bureau-session-persistence';

describe('createSessionPersistence', () => {
  it('matches native object-spread semantics for malformed incoming strings and arrays', async () => {
    let storedSession: AgentSession | undefined = createAgentSession({
      id: 'session-merge',
      agentName: 'default',
      conversationHistory: createConversationHistory({ id: 'session-merge' }),
      metadata: {
        lastRequestAuthorities: { existing: 'keep' },
        lastRunOwningPrincipals: { existing: 'keep' },
      },
    });
    const sessionStore: Pick<SessionStore, 'load' | 'update'> = {
      load: async () => storedSession,
      update: async (_id, updater) => {
        storedSession = (await updater(storedSession)) ?? undefined;
        return storedSession;
      },
    };
    const persistence = createSessionPersistence({
      sessionStore,
      orphanedRunIds: new Set(),
      store: { getRun: () => undefined },
      retryDelayMilliseconds: 1,
      sleep: async () => {},
      diagnose: () => {},
      serializeError: String,
    });
    const incomingOwners: JSONValue[] = [];
    incomingOwners[2] = 'sparse';
    Object.defineProperty(incomingOwners, 'extra', { value: 'extra', enumerable: true });
    const conversation = new Conversation(createConversationHistory({ id: 'session-merge' }));

    await persistence.saveSession('session-merge', conversation, {
      lastRequestAuthorities: '😀',
      lastRunOwningPrincipals: incomingOwners,
    });

    expect(storedSession?.metadata['lastRequestAuthorities']).toEqual(
      Object.assign({}, { existing: 'keep' }, '😀'),
    );
    expect(storedSession?.metadata['lastRunOwningPrincipals']).toEqual(
      Object.assign({}, { existing: 'keep' }, incomingOwners),
    );
  });

  it('saves only to the expected incarnation, never recreating a deleted session', async () => {
    let storedSession: AgentSession | undefined;
    const sessionStore: Pick<SessionStore, 'load' | 'update'> = {
      load: async () => storedSession,
      update: async (_id, updater) => {
        // `undefined` leaves the session unchanged, as `SessionStore.update` documents.
        storedSession = (await updater(storedSession)) ?? storedSession;
        return storedSession;
      },
    };
    const persistence = createSessionPersistence({
      sessionStore,
      orphanedRunIds: new Set(),
      store: { getRun: () => undefined },
      retryDelayMilliseconds: 1,
      sleep: async () => {},
      diagnose: () => {},
      serializeError: String,
    });
    const conversation = new Conversation(createConversationHistory({ id: 'session-fenced' }));
    const save = (expectedIncarnation: string) =>
      persistence.saveSession(
        'session-fenced',
        conversation,
        { lastRunId: 'run-1', lastRunStatus: 'completed' },
        undefined,
        undefined,
        expectedIncarnation,
      );

    // Deleted in another process: the run's terminal save must not recreate it.
    await save('incarnation-1');
    expect(storedSession).toBeUndefined();

    // Recreated under a new incarnation: the old run's save must not touch it.
    storedSession = {
      ...createAgentSession({
        id: 'session-fenced',
        agentName: 'default',
        conversationHistory: createConversationHistory({ id: 'session-fenced' }),
      }),
      incarnation: 'incarnation-2',
    };
    await save('incarnation-1');
    expect(storedSession.metadata['lastRunStatus']).toBeUndefined();

    await save('incarnation-2');
    expect(storedSession.metadata['lastRunStatus']).toBe('completed');
  });
});
