import { describe, expect, it } from 'bun:test';
import { createAgent, createSessionStore } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type Storage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createBureau } from './create-bureau.ts';
import { readSteeringLogEntries, readSteeringLogHead } from './steering-log.ts';

describe('reserved task admission', () => {
  for (const failAfterPrepare of [false, true])
    it(`keeps the owner when another host observes its prepared receipt (failure: ${failAfterPrepare})`, async () => {
      const storage = new MemoryStorage();
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let armed = true;
      const wrapped = new Proxy(storage, {
        get(target, property, receiver) {
          if (property === 'conditionalBatch')
            return async (...args: Parameters<NonNullable<Storage['conditionalBatch']>>) => {
              const committed = await target.conditionalBatch(...args);
              if (
                committed &&
                armed &&
                args[1].some(
                  (operation) => operation.type === 'put' && operation.key === 'wf:receipt-race',
                )
              ) {
                armed = false;
                reached.resolve();
                await release.promise;
                if (failAfterPrepare) throw new Error('injected prepare acknowledgement failure');
              }
              return committed;
            };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const options = {
        durable: true as const,
        requestAuthorityValidator: () => true,
        agents: {
          assistant: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
        },
      };
      const first = await createBureau({ ...options, storage: wrapped });
      const second = await createBureau({ ...options, storage });
      try {
        const started = first.tasks.start('assistant', 'hello', {
          principal: 'alice',
          commandId: 'receipt-command',
          requestContext: {
            authority: {
              principalId: 'alice',
              tenantId: 'tenant',
              ownerId: 'alice',
              capabilities: [],
              authorizationRevision: 'v1',
            },
          },
          reservation: { runId: 'receipt-race', sessionId: 'receipt-session', fence: 1 },
        });
        void started.catch(() => {});
        await reached.promise;
        const receipt = await second.tasks.receipt({
          principal: 'alice',
          commandId: 'receipt-command',
          agentName: 'assistant',
        });
        expect(receipt.status).toBe('recorded');
        release.resolve();
        if (failAfterPrepare) {
          expect(await throwingRejectionOf(started)).toThrow(
            'injected prepare acknowledgement failure',
          );
          const kv = textValueStore(storage);
          const session = await createSessionStore(kv).load('receipt-session');
          if (!session) throw new Error('Missing failed session');
          const head = await readSteeringLogHead(kv, session.id, session.incarnation);
          const events = await readSteeringLogEntries(
            kv,
            session.id,
            session.incarnation,
            0,
            head.sequence,
          );
          expect(events.filter((event) => event.type === 'run-ended')).toHaveLength(1);
        } else {
          const task = await started;
          expect(task.id).toBe('receipt-race');
          await task.result();
          expect(await first.tasks.get('receipt-race')).toMatchObject({ status: 'completed' });
        }
      } finally {
        release.resolve();
        await first.dispose();
        await second.dispose();
      }
    });
  it('refuses reserved starts without workflow-lease ownership before admission', async () => {
    const bureau = await createBureau({
      storage: new MemoryStorage(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      agents: {
        assistant: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
    });
    try {
      expect(
        await throwingRejectionOf(
          bureau.tasks.start('assistant', 'hello', {
            principal: 'alice',
            commandId: 'command',
            reservation: { runId: 'run', sessionId: 'session', fence: 1 },
            requestContext: {
              authority: {
                principalId: 'alice',
                tenantId: 'tenant',
                ownerId: 'alice',
                capabilities: [],
                authorizationRevision: 'v1',
              },
            },
          }),
        ),
      ).toThrow('workflow-lease');
      expect(await bureau.tasks.workflow('run')).toBeNull();
    } finally {
      await bureau.dispose();
    }
  });
  for (const blockedKey of ['wf:reserved-race', 'bureau-task:v1:reserved-race'])
    it(`does not settle the successor when the old claimant loses at ${blockedKey}`, async () => {
      const storage = new MemoryStorage();
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let armed = true;
      const wrapped = new Proxy(storage, {
        get(target, property, receiver) {
          if (property === 'conditionalBatch')
            return async (...args: Parameters<NonNullable<Storage['conditionalBatch']>>) => {
              if (
                armed &&
                args[1].some(
                  (operation) => operation.type === 'put' && operation.key === blockedKey,
                )
              ) {
                armed = false;
                reached.resolve();
                await release.promise;
              }
              return target.conditionalBatch(...args);
            };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const options = {
        durable: true as const,
        requestAuthorityValidator: () => true,
        agents: {
          assistant: createAgent({
            generate: async () => {
              await finish.promise;
              return { content: 'done', toolCalls: [] };
            },
          }),
        },
      };
      const first = await createBureau({ ...options, storage: wrapped });
      const second = await createBureau({ ...options, storage });
      const context = {
        authority: {
          principalId: 'alice',
          tenantId: 'tenant',
          ownerId: 'alice',
          capabilities: [],
          authorizationRevision: 'v1',
        },
      };
      try {
        const old = first.tasks.start('assistant', 'hello', {
          principal: 'alice',
          commandId: 'command',
          requestContext: context,
          reservation: { runId: 'reserved-race', sessionId: 'reserved-race-session', fence: 1 },
        });
        void old.catch(() => {});
        await reached.promise;
        const successor = await second.tasks.start('assistant', 'hello', {
          principal: 'alice',
          commandId: 'command',
          requestContext: context,
          reservation: { runId: 'reserved-race', sessionId: 'reserved-race-session', fence: 2 },
        });
        release.resolve();
        await old.catch(() => {});
        await first.internals.taskRegistry.flush();
        const kv = textValueStore(storage);
        const session = await createSessionStore(kv).load('reserved-race-session');
        expect(session?.metadata).toMatchObject({
          lastRunStatus: 'running',
          reservedStartFence: 2,
        });
        if (!session) throw new Error('Missing successor session');
        const head = await readSteeringLogHead(kv, session.id, session.incarnation);
        const events = await readSteeringLogEntries(
          kv,
          session.id,
          session.incarnation,
          0,
          head.sequence,
        );
        expect(events.filter((event) => event.type === 'run-ended')).toEqual([]);
        expect(await second.tasks.get('reserved-race').then((value) => value?.status)).not.toBe(
          'failed',
        );
        finish.resolve();
        await successor.result();
        expect(await second.tasks.get('reserved-race')).toMatchObject({
          id: 'reserved-race',
          status: 'completed',
        });
      } finally {
        release.resolve();
        finish.resolve();
        await first.dispose();
        await second.dispose();
      }
    });
  it('ends steering when the failing reserved starter still owns its claim', async () => {
    const storage = new MemoryStorage();
    const wrapped = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch')
          return async (...args: Parameters<NonNullable<Storage['conditionalBatch']>>) => {
            if (
              args[1].some(
                (operation) =>
                  operation.type === 'put' && operation.key === 'bureau-task:v1:reserved-owned',
              )
            )
              throw new Error('injected admission failure');
            return target.conditionalBatch(...args);
          };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bureau = await createBureau({
      storage: wrapped,
      durable: true,
      requestAuthorityValidator: () => true,
      agents: {
        assistant: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
    });
    try {
      expect(
        await throwingRejectionOf(
          bureau.tasks.start('assistant', 'hello', {
            principal: 'alice',
            commandId: 'owned',
            reservation: { runId: 'reserved-owned', sessionId: 'reserved-owned-session', fence: 1 },
            requestContext: {
              authority: {
                principalId: 'alice',
                tenantId: 'tenant',
                ownerId: 'alice',
                capabilities: [],
                authorizationRevision: 'v1',
              },
            },
          }),
        ),
      ).toThrow('injected admission failure');
      const kv = textValueStore(storage);
      const session = await createSessionStore(kv).load('reserved-owned-session');
      expect(session?.metadata['lastRunStatus']).toBe('error');
      if (!session) throw new Error('Missing failed session');
      const head = await readSteeringLogHead(kv, session.id, session.incarnation);
      const events = await readSteeringLogEntries(
        kv,
        session.id,
        session.incarnation,
        0,
        head.sequence,
      );
      expect(events.filter((event) => event.type === 'run-ended')).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });
  it('starts and replays the reserved run and session', async () => {
    const bureau = await createBureau({
      storage: new MemoryStorage(),
      durable: true,
      requestAuthorityValidator: () => true,
      agents: {
        assistant: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
    });
    try {
      const reservation = { runId: 'reserved-run', sessionId: 'reserved-session', fence: 1 };
      const requestContext = {
        authority: {
          principalId: 'alice',
          tenantId: 'tenant',
          ownerId: 'alice',
          capabilities: [],
          authorizationRevision: 'v1',
        },
      };
      const first = await bureau.tasks.start('assistant', 'hello', {
        principal: 'alice',
        commandId: 'command',
        reservation,
        requestContext,
      });
      expect(first.id).toBe(reservation.runId);
      expect(first.contextId).toBe(reservation.sessionId);
      await first.result();
      const replay = await bureau.tasks.start('assistant', 'hello', {
        principal: 'alice',
        commandId: 'command',
        reservation,
        requestContext: { authority: { ...requestContext.authority, authorizationRevision: 'v2' } },
      });
      expect(replay.id).toBe(first.id);
      expect(replay.contextId).toBe(first.contextId);
      expect(
        await bureau.tasks
          .start('assistant', 'hello', {
            principal: 'alice',
            commandId: 'command',
            reservation,
            requestContext: { authority: { ...requestContext.authority, tenantId: 'other' } },
          })
          .then(
            () => false,
            () => true,
          ),
      ).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });
});
