import { describe, expect, it } from 'bun:test';

import { Engine } from '../../engine/index.ts';
import { activity } from '../activity.ts';
import { query, signal, update } from '../message-handles.ts';
import { WorkflowBuilderError } from '../workflow-builder-runtime.ts';
import { createWorkflowFactory } from '../workflow-factory.ts';

const approve = signal<{ approverId: string }>('approve');

describe('createWorkflowFactory() — shared entries', () => {
  it('gives every workflow the shared entries as its own', () => {
    const { workflow } = createWorkflowFactory({
      activities: { greet: async (name: string) => `Hello, ${name}` },
      signals: { approve },
      updates: { check: update<{ id: string }, { ok: boolean }>('check') },
      queries: { progress: query<void, number>('progress') },
    });

    const first = workflow({ name: 'first' }).execute(async function* () {
      return 1;
    });
    const second = workflow({ name: 'second' }).execute(async function* () {
      return 2;
    });

    for (const built of [first, second]) {
      expect(Object.keys(built.activities)).toEqual(['greet']);
      expect(built.activities['greet']?.name).toBe('greet');
      expect(Object.keys(built.signals)).toEqual(['approve']);
      expect(Object.keys(built.updates)).toEqual(['check']);
      expect(Object.keys(built.queries)).toEqual(['progress']);
    }
    // Each workflow freezes its own copy, so one cannot reach another's.
    expect(first.activities['greet']).not.toBe(second.activities['greet']);
    expect(Object.isFrozen(first.activities['greet'])).toBe(true);
  });

  it('merges a workflow’s own entries onto the shared ones', () => {
    const { workflow } = createWorkflowFactory({
      activities: { greet: async (name: string) => `Hello, ${name}` },
      signals: { approve },
      updates: { check: update<void, boolean>('check') },
      queries: { progress: query<void, number>('progress') },
    });

    const built = workflow({ name: 'merged' })
      .activities({ shout: async (text: string) => text.toUpperCase() })
      .signals({ reject: signal<{ reason: string }>('reject') })
      .updates({ rename: update<string, boolean>('rename') })
      .queries({ status: query<void, string>('status') })
      .execute(async function* () {
        return 0;
      });

    expect(Object.keys(built.activities)).toEqual(['greet', 'shout']);
    expect(Object.keys(built.signals)).toEqual(['approve', 'reject']);
    expect(Object.keys(built.updates)).toEqual(['check', 'rename']);
    expect(Object.keys(built.queries)).toEqual(['progress', 'status']);
  });

  it('accepts every activity shape `.activities()` accepts', () => {
    const charge = activity({ name: 'charge', execute: async (amount: number) => amount * 2 });
    const { workflow } = createWorkflowFactory({
      activities: {
        charge,
        refund: { execute: async (amount: number) => -amount, idempotent: true },
      },
    });
    const built = workflow({ name: 'shapes' }).execute(async function* () {
      return 0;
    });
    expect(built.activities['charge']?.name).toBe('charge');
    expect(built.activities['refund']?.idempotent).toBe(true);
  });

  it('builds plain workflows when given no entries', () => {
    const { workflow } = createWorkflowFactory({});
    const built = workflow({ name: 'plain' })
      .activities({ ping: async () => 'pong' })
      .execute(async function* () {
        return 0;
      });
    expect(Object.keys(built.activities)).toEqual(['ping']);
    expect(built.signals).toEqual({});
  });

  it('does not see later mutation of the maps it was given', () => {
    const signals: Record<string, typeof approve> = { approve };
    const { workflow } = createWorkflowFactory({ signals });
    signals['late'] = signal<{ approverId: string }>('late');
    const built = workflow({ name: 'snapshot' }).execute(async function* () {
      return 0;
    });
    expect(Object.keys(built.signals)).toEqual(['approve']);
  });
});

describe('createWorkflowFactory() — conflicts and validation', () => {
  const { workflow } = createWorkflowFactory({
    activities: { greet: async (name: string) => `Hello, ${name}` },
    signals: { approve },
    updates: { check: update<void, boolean>('check') },
    queries: { progress: query<void, number>('progress') },
  });

  // The type layer rejects these too; the casts reach the runtime check that
  // untyped callers hit.
  type Untyped = Record<string, (map: object) => unknown>;
  const cases: Array<[method: string, map: object, name: string]> = [
    ['activities', { greet: async () => 'again' }, 'greet'],
    ['signals', { approve }, 'approve'],
    ['updates', { check: update<void, boolean>('check') }, 'check'],
    ['queries', { progress: query<void, number>('progress') }, 'progress'],
  ];

  for (const [method, map, name] of cases) {
    it(`rejects .${method}() redeclaring a shared name`, () => {
      const builder = workflow({ name: 'conflict' }) as unknown as Untyped;
      expect(() => builder[method]!(map)).toThrow(WorkflowBuilderError);
      expect(() => (workflow({ name: 'conflict' }) as unknown as Untyped)[method]!(map)).toThrow(
        `.${method}() declares "${name}", which the workflow factory already declares`,
      );
    });
  }

  it('validates shared activity names when the factory is created', () => {
    expect(() => createWorkflowFactory({ activities: { 'bad.name': async () => 1 } })).toThrow(
      /activity name "bad\.name"/,
    );
  });

  it('validates the workflow name like workflow() does', () => {
    expect(() => workflow({ name: 'bad.name' })).toThrow(/workflow name "bad\.name"/);
    expect(() => workflow({ name: '' })).toThrow(
      'workflow() requires an options object with a name.',
    );
  });
});

describe('createWorkflowFactory() — on an engine', () => {
  it('registers shared entries per workflow and runs them', async () => {
    const { workflow } = createWorkflowFactory({
      activities: { greet: async (name: string) => `Hello, ${name}` },
      signals: { approve },
    });

    const welcome = workflow({ name: 'welcome' })
      .activities({ shout: async (text: string) => text.toUpperCase() })
      .execute(async function* (ctx, name: string) {
        const greeting = yield* ctx.run('greet', name);
        const { approverId } = yield* ctx.waitForSignal('approve');
        return { greeting: yield* ctx.run('shout', greeting), approverId };
      });
    const farewell = workflow({ name: 'farewell' }).execute(async function* (ctx, name: string) {
      return yield* ctx.run('greet', name);
    });

    const engine = await Engine.create({ workflows: { welcome, farewell }, recover: false });
    try {
      // Registered per workflow, not on the engine's global registry.
      expect(engine.listActivityDefinitions().map((entry) => entry.name)).toEqual([]);
      expect(engine.listWorkflowActivityDefinitions('welcome').map((entry) => entry.name)).toEqual([
        'greet',
        'shout',
      ]);
      expect(engine.listWorkflowActivityDefinitions('farewell').map((entry) => entry.name)).toEqual(
        ['greet'],
      );
      expect(Object.keys(engine.getWorkflowDefinition('farewell')?.signals ?? {})).toEqual([
        'approve',
      ]);

      const welcomeHandle = await engine.start('welcome', 'Ada');
      await engine.signal(welcomeHandle.id, approve, { approverId: 'user-1' });
      expect(await welcomeHandle.result()).toEqual({
        greeting: 'HELLO, ADA',
        approverId: 'user-1',
      });

      const farewellHandle = await engine.start('farewell', 'Grace');
      expect(await farewellHandle.result()).toBe('Hello, Grace');
    } finally {
      await engine.shutdown();
    }
  });
});
