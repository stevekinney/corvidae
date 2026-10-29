import { createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it, spyOn } from 'bun:test';

import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import {
  isTaskOrigin,
  parseStartTaskOrigin,
  TASK_ORIGIN_KINDS,
  taskOriginOfStart,
  taskOriginTag,
} from './task-origin';

const START = { sessionId: 'context-1', agentName: 'assistant', owner: 'api-key:alice' } as const;

describe('isTaskOrigin', () => {
  it('accepts each kind with every identifier it names', () => {
    expect(isTaskOrigin({ kind: 'api' })).toBe(true);
    expect(isTaskOrigin({ kind: 'chat', contextId: 'c', agentName: 'a', principal: 'p' })).toBe(
      true,
    );
    expect(isTaskOrigin({ kind: 'person', principal: 'p', surface: 'web' })).toBe(true);
    expect(isTaskOrigin({ kind: 'schedule', scheduleId: 's', fireId: 'f' })).toBe(true);
    expect(isTaskOrigin({ kind: 'schedule', scheduleId: 's', fireId: 'f', manual: true })).toBe(
      true,
    );
  });

  it('rejects what a reader could not use, and every name an object inherits', () => {
    for (const value of [
      undefined,
      null,
      'api',
      [],
      {},
      { kind: 'teleport' },
      { kind: 'constructor' },
      { kind: '__proto__' },
      { kind: 'toString' },
      { kind: 'chat', contextId: 'c', agentName: 'a' },
      { kind: 'person', principal: 'p', surface: 'fax' },
      { kind: 'schedule', scheduleId: 's', fireId: '' },
      { kind: 'schedule', scheduleId: 's', fireId: 'f', manual: false },
    ]) {
      expect(isTaskOrigin(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('parseStartTaskOrigin', () => {
  it('returns what a caller may declare and nothing else of it', () => {
    expect(parseStartTaskOrigin(undefined)).toBeUndefined();
    expect(parseStartTaskOrigin({ kind: 'chat', principal: 'mallory' })).toEqual({ kind: 'chat' });
    expect(parseStartTaskOrigin({ kind: 'api' })).toEqual({ kind: 'api' });
    expect(parseStartTaskOrigin({ kind: 'person', surface: 'palette', principal: 'x' })).toEqual({
      kind: 'person',
      surface: 'palette',
    });
  });

  it('refuses a schedule, an unknown kind, a person without a surface, and a non-object', () => {
    for (const value of [
      { kind: 'schedule', scheduleId: 's', fireId: 'f' },
      { kind: 'nope' },
      { kind: 'person' },
      { kind: 'person', surface: 'fax' },
      'chat',
      null,
    ]) {
      expect(() => parseStartTaskOrigin(value), JSON.stringify(value)).toThrow(TypeError);
    }
  });
});

describe('taskOriginOfStart', () => {
  it('fills a chat from the start itself, never from the declaration', () => {
    expect(taskOriginOfStart({ kind: 'chat' }, START)).toEqual({
      kind: 'chat',
      contextId: 'context-1',
      agentName: 'assistant',
      principal: 'api-key:alice',
    });
  });

  it('makes the owner the person, and an undeclared start an api one', () => {
    expect(taskOriginOfStart({ kind: 'person', surface: 'web' }, START)).toEqual({
      kind: 'person',
      principal: 'api-key:alice',
      surface: 'web',
    });
    expect(taskOriginOfStart(undefined, START)).toEqual({ kind: 'api' });
    expect(taskOriginOfStart({ kind: 'api' }, START)).toEqual({ kind: 'api' });
  });
});

describe('taskOriginTag', () => {
  it('names the kind, for every kind', () => {
    expect(TASK_ORIGIN_KINDS.map((kind) => taskOriginTag({ kind }))).toEqual([
      'origin:chat',
      'origin:person',
      'origin:schedule',
      'origin:api',
    ]);
  });
});

/** The engine class every Bureau composes: its prepared runs are observed, not replaced. */
async function durableEnginePrototype() {
  const probe = await createRuntimeComposition({
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: new MemoryStorage(),
    durable: true,
  });
  const prototype = Object.getPrototypeOf(probe.durable!.engine) as {
    prepare: (type: string, input: unknown, options?: { id?: string; tags?: string[] }) => unknown;
  };
  probe.durable!.engine[Symbol.dispose]?.();
  return prototype;
}

describe('the run a task starts', () => {
  it('is tagged with its origin kind, beside the steering tag, and its record keeps the identifiers', async () => {
    const started = spyOn(await durableEnginePrototype(), 'prepare');
    const bureau = await createBureau({
      agents: {
        default: createAgent({
          generate: () => new Promise<never>(() => {}),
          toolbox: createToolbox([]),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    try {
      const declared = [
        [undefined, { kind: 'api' }],
        [{ kind: 'api' }, { kind: 'api' }],
        [
          { kind: 'person', surface: 'palette' },
          { kind: 'person', principal: 'alice', surface: 'palette' },
        ],
      ] as const;
      for (const [origin, expected] of declared) {
        started.mockClear();
        const task = await bureau.tasks.start('default', 'work', {
          principal: 'alice',
          ...(origin === undefined ? {} : { origin }),
        });
        const call = started.mock.calls.find(([type]) => type === 'agentRun');
        const tags = call?.[2]?.tags ?? [];

        const view = await bureau.internals.taskRegistry.get(task.id);
        expect(view?.origin).toEqual(expected);
        expect(tags).toContain(`origin:${expected.kind}`);
        task.abort('test over');
      }
      const chat = await bureau.tasks.start('default', 'hello', {
        principal: 'alice',
        contextId: 'chat-context',
        origin: { kind: 'chat' },
      });
      const chatView = await bureau.internals.taskRegistry.get(chat.id);
      expect(chatView?.origin).toEqual({
        kind: 'chat',
        contextId: 'chat-context',
        agentName: 'default',
        principal: 'alice',
      });
      chat.abort('test over');
    } finally {
      started.mockRestore();
      await bureau.dispose();
    }
  });

  it('refuses an origin it cannot record before any task exists', async () => {
    const bureau = await createBureau({
      agents: {
        default: createAgent({
          generate: () => new Promise<never>(() => {}),
          toolbox: createToolbox([]),
        }),
      },
    });
    try {
      for (const origin of [{ kind: 'schedule' }, { kind: 'person' }, 'chat']) {
        let failure: unknown;
        try {
          await bureau.tasks.start('default', 'work', {
            principal: 'alice',
            origin: origin as never,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure, JSON.stringify(origin)).toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(await bureau.internals.taskRegistry.enumerate({ limit: 10, offset: 0 })).toMatchObject(
        {
          tasks: [],
        },
      );
    } finally {
      await bureau.dispose();
    }
  });
});
