import { createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it, spyOn } from 'bun:test';

import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import {
  isStoredTaskOrigin,
  isTaskOrigin,
  isTopLevelTaskOrigin,
  parseStartTaskOrigin,
  TASK_ORIGIN_KINDS,
  taskOriginOfStart,
  taskOriginParentOf,
  taskOriginParentTag,
  taskOriginTag,
  taskOriginView,
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
    expect(isTaskOrigin({ kind: 'agent', parentRunId: 'r', agentName: 'a' })).toBe(true);
    expect(
      isTaskOrigin({
        kind: 'agent',
        parentRunId: 'r',
        parentContextId: 'c',
        agentName: 'a',
        toolCallId: 't',
      }),
    ).toBe(true);
    expect(isTaskOrigin({ kind: 'goal', goalRunId: 'g', attemptId: 'goal-g-a0' })).toBe(true);
    expect(isTaskOrigin({ kind: 'parent', parentRunId: 'r' })).toBe(true);
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
      { kind: 'agent', parentRunId: 'r' },
      { kind: 'agent', parentRunId: '', agentName: 'a' },
      { kind: 'agent', parentRunId: 'r', agentName: 'a', toolCallId: '' },
      { kind: 'agent', parentRunId: 'r', agentName: 'a', parentContextId: 1 },
      { kind: 'goal', goalRunId: 'g' },
      { kind: 'parent' },
      { kind: 'parent', parentRunId: '' },
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
      // A caller can never declare a subordinate kind.
      { kind: 'agent', parentRunId: 'r', agentName: 'a' },
      { kind: 'goal', goalRunId: 'g', attemptId: 'a' },
      { kind: 'parent', parentRunId: 'r' },
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
      'origin:agent',
      'origin:goal',
      'origin:parent',
    ]);
  });
});

describe('taskOriginParentOf', () => {
  it('names the run a subordinate task belongs to, and nothing for any other origin', () => {
    expect(taskOriginParentOf({ kind: 'agent', parentRunId: 'r', agentName: 'a' })).toBe('r');
    expect(taskOriginParentOf({ kind: 'parent', parentRunId: 'w' })).toBe('w');
    expect(taskOriginParentOf({ kind: 'goal', goalRunId: 'g', attemptId: 'a0' })).toBe('g');
    expect(taskOriginParentOf({ kind: 'api' })).toBeNull();
    expect(
      taskOriginParentOf({ kind: 'chat', contextId: 'c', agentName: 'a', principal: 'p' }),
    ).toBeNull();
    expect(taskOriginParentOf(undefined)).toBeNull();
    expect(taskOriginParentOf(null)).toBeNull();
    // A kind this release does not know, or a known kind it cannot read, is attributed to nobody.
    expect(taskOriginParentOf({ kind: 'teleport', parentRunId: 'r' })).toBeNull();
    expect(taskOriginParentOf({ kind: 'agent', parentRunId: 'r' })).toBeNull();
  });
});

describe('isTopLevelTaskOrigin', () => {
  it('admits an absent origin and the kinds a person, a schedule or the API starts', () => {
    expect(isTopLevelTaskOrigin(undefined)).toBe(true);
    expect(isTopLevelTaskOrigin({ kind: 'api' })).toBe(true);
    expect(isTopLevelTaskOrigin({ kind: 'chat' })).toBe(true);
    expect(isTopLevelTaskOrigin({ kind: 'person' })).toBe(true);
    expect(isTopLevelTaskOrigin({ kind: 'schedule' })).toBe(true);
  });

  it('refuses the subordinate kinds, and every kind it does not know', () => {
    for (const kind of ['agent', 'goal', 'parent', 'teleport', 'constructor', '__proto__']) {
      expect(isTopLevelTaskOrigin({ kind }), kind).toBe(false);
    }
  });
});

describe('taskOriginParentTag', () => {
  it('spells the parent run when the tag fits Weft’s limit', () => {
    expect(taskOriginParentTag('agent-run-1')).toBe('origin-parent:agent-run-1');
    expect(taskOriginParentTag('x'.repeat(114))).toBe(`origin-parent:${'x'.repeat(114)}`);
  });

  it('hashes a parent run that would not fit, the same way every time', () => {
    const long = 'x'.repeat(115);
    const tag = taskOriginParentTag(long);

    expect(tag).toMatch(/^origin-parent-sha256:[0-9a-f]{40}$/);
    expect(taskOriginParentTag(long)).toBe(tag);
    expect(taskOriginParentTag(`${long}y`)).not.toBe(tag);
    expect(new TextEncoder().encode(tag).byteLength).toBeLessThanOrEqual(128);
    // Multi-byte ids count in bytes, not characters.
    expect(taskOriginParentTag('é'.repeat(60))).toStartWith('origin-parent-sha256:');
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

describe('the stored origin rule (COR-1867)', () => {
  it('accepts any object with a non-empty kind, and the view shows only origins it can read', () => {
    expect(isStoredTaskOrigin({ kind: 'agent', parentRunId: 'run-0' })).toBe(true);
    expect(isStoredTaskOrigin({ kind: 'chat' })).toBe(true);
    for (const value of [undefined, null, 'chat', [], {}, { kind: '' }, { kind: 3 }]) {
      expect(isStoredTaskOrigin(value), JSON.stringify(value)).toBe(false);
    }
    expect(taskOriginView({ kind: 'api' })).toEqual({ kind: 'api' });
    expect(taskOriginView({ kind: 'agent' })).toBeNull();
    expect(taskOriginView({ kind: 'chat' })).toBeNull();
    expect(taskOriginView(undefined)).toBeNull();
  });
});
