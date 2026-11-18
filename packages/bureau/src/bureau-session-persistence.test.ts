import {
  type AgentSession,
  createAgentSession,
  type JSONValue,
  type SessionStore,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createSessionPersistence } from './bureau-session-persistence';
import { ContextHistoryChangedError } from './bureau-errors';
import { removeSessionTurn } from './session-discard';

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

  // COR-2437 review: a run that loaded the chat before a discard committed, and saves after it,
  // wrote the discarded rows back, because a row missing from the stored chat read as new.
  describe('a save racing a removal it did not make', () => {
    const rows = (ids: readonly string[]) => {
      const conversation = new Conversation(createConversationHistory({ id: 'session-raced' }));
      for (const id of ids) {
        conversation.appendMessages({
          role: id.startsWith('u') ? 'user' : 'assistant',
          content: id,
          id,
        } as never);
      }
      return conversation;
    };
    function persistenceOver(ids: readonly string[]) {
      let storedSession: AgentSession | undefined = createAgentSession({
        id: 'session-raced',
        agentName: 'default',
        conversationHistory: rows(ids).current,
        metadata: { sessionOwner: 'alice' },
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
      return {
        persistence,
        stored: () => storedSession!,
        // Removes the row as a discard does: from the history, naming it as discarded.
        remove: (id: string) => {
          storedSession = removeSessionTurn(
            storedSession!,
            'run',
            [id],
            '2026-11-18T00:00:00.000Z',
          );
        },
      };
    }

    // The 18 createBureau failures of 1cf0d4b77: a save that names no base of its own (recovery,
    // steering and shutdown saves take the candidate as their base) must still write the rows the
    // run added. Only a discard's named rows stay out.
    it('writes the rows a save added when its base is its own candidate', async () => {
      const over = persistenceOver(['u1']);
      const conversation = rows(['u1']);
      conversation.appendMessages({
        role: 'assistant',
        content: 'recovered step 1',
        id: 'run:step:1',
      } as never);

      await over.persistence.saveSession('session-raced', conversation, {});

      expect(over.stored().conversationHistory.ids).toEqual(['u1', 'run:step:1']);
    });

    it('keeps a row another writer removed out of a terminal save', async () => {
      const over = persistenceOver(['u1', 'run:step:0']);
      const conversation = rows(['u1', 'run:step:0']);
      const base = conversation.current;
      conversation.appendMessages({
        role: 'assistant',
        content: 'later',
        id: 'other:step:0',
      } as never);
      over.remove('run:step:0');

      await over.persistence.saveSession('session-raced', conversation, {}, undefined, base);

      expect(over.stored().conversationHistory.ids).toEqual(['u1', 'other:step:0']);
    });

    it('refuses a run start whose loaded chat lost a row before it saved, so its model never reads it', async () => {
      const over = persistenceOver(['u1', 'run:step:0']);
      const conversation = rows(['u1', 'run:step:0']);
      const base = conversation.current;
      conversation.appendMessages({ role: 'user', content: 'next', id: 'u2' } as never);
      over.remove('run:step:0');

      const refused = await over.persistence
        .saveSession('session-raced', conversation, {}, undefined, base, undefined, undefined, true)
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(ContextHistoryChangedError);
      expect(over.stored().conversationHistory.ids).toEqual(['u1']);
    });

    it('starts a run as before when nothing it loaded was removed', async () => {
      const over = persistenceOver(['u1']);
      const conversation = rows(['u1']);
      const base = conversation.current;
      conversation.appendMessages({ role: 'user', content: 'next', id: 'u2' } as never);

      await over.persistence.saveSession(
        'session-raced',
        conversation,
        {},
        undefined,
        base,
        undefined,
        undefined,
        true,
      );

      expect(over.stored().conversationHistory.ids).toEqual(['u1', 'u2']);
    });
  });
});
