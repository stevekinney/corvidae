/**
 * COR-1590 — `.` and `..` may not name a session that does not exist yet. A browser resolves them
 * out of the address a client would open the session at, so a session created under one could
 * never be opened again. `createRun` and `createSchedule` refuse them as `BAD_REQUEST` with a
 * message beginning `unopenable-session-identifier:`; the AG-UI mount refuses a start that would
 * create one as `INVALID_INPUT` (`http/ag-ui-mount-routes.test.ts`).
 */
import {
  createAgentSession,
  createMockGenerate,
  createSessionStore,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type Storage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import {
  createCheckValidator,
  createDiagnostics,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot() {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      worker: workerAgent(hangUntilAborted),
      default: createAgent({
        generate: createMockGenerate([{ content: 'ok', toolCalls: [] }]),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    validators: [createCheckValidator()],
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau;
  open.push(typed);
  return typed;
}

const UNOPENABLE = ['.', '..'];

describe('a session id a browser would resolve away', () => {
  it.each(UNOPENABLE)('may not be the new session %s of createRun', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau
      .createRun({ agentName: 'default', message: 'hello', sessionId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('unopenable-session-identifier');
    expect(await bureau.getSession(sessionId)).toBeUndefined();
  });

  it.each(UNOPENABLE)('may not be the new session %s of a schedule', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau
      .createSchedule({ agentName: 'worker', input: 'x', spec: '1h', sessionId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('unopenable-session-identifier');
  });

  it('is still free when it only contains dots', async () => {
    const bureau = await boot();

    const run = await bureau.createRun({
      agentName: 'default',
      message: 'hello',
      sessionId: '...',
    });

    expect(run.sessionId).toBe('...');
  });
});

/** Memory storage that counts the reads that name a session's record. */
function countingSessionReads() {
  const storage = new MemoryStorage();
  let reads = 0;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (
          ['get', 'scan', 'has'].includes(String(property)) &&
          JSON.stringify(args).includes('agent-session')
        ) {
          reads += 1;
        }
        return (member as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { storage: proxy as unknown as Storage, reads: () => reads };
}

async function bootOver(storage: Storage) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      worker: workerAgent(hangUntilAborted),
      default: createAgent({
        generate: createMockGenerate([{ content: 'ok', toolCalls: [] }]),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage,
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau;
  open.push(typed);
  return typed;
}

describe('a session that already holds an id a browser would resolve away', () => {
  it.each(UNOPENABLE)(
    'keeps working: createRun and a schedule take the session %s',
    async (sessionId) => {
      // Such a session can exist: another client, or an earlier version, made it. The refusal is for
      // creating one.
      const storage = new MemoryStorage() as unknown as Storage;
      await createSessionStore(textValueStore(storage)).save(
        createAgentSession({
          id: sessionId,
          agentName: 'default',
          conversationHistory: createConversationHistory({ id: sessionId }),
          metadata: {},
        }),
      );
      const bureau = await bootOver(storage);

      const run = await bureau.createRun({
        agentName: 'default',
        message: 'hello again',
        sessionId,
      });
      const schedule = await bureau.createSchedule({
        agentName: 'worker',
        input: 'x',
        spec: '1h',
        sessionId,
      });

      expect(run.sessionId).toBe(sessionId);
      expect(schedule?.id).toBeDefined();
    },
  );
});

describe('a schedule', () => {
  it('names an ordinary session without a read of the session store', async () => {
    const counted = countingSessionReads();
    const bureau = await bootOver(counted.storage);
    const before = counted.reads();

    await bureau.createSchedule({
      agentName: 'worker',
      input: 'x',
      spec: '1h',
      sessionId: 'recurring',
    });

    expect(counted.reads()).toBe(before);
  });

  it('reads the store before it refuses a dot-only id, which an existing session may hold', async () => {
    const counted = countingSessionReads();
    const bureau = await bootOver(counted.storage);
    const before = counted.reads();

    await bureau
      .createSchedule({ agentName: 'worker', input: 'x', spec: '1h', sessionId: '.' })
      .catch(() => undefined);

    expect(counted.reads()).toBeGreaterThan(before);
  });
});
