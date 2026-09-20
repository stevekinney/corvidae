/**
 * COR-75: `engine.prepare()` / `handle.launch()` / `handle.abandon()`.
 *
 * Criterion 4: the two-phase surface exists with the same ownership and
 * lease semantics as `start()` — proven here by a caller-provided id
 * colliding against a still-`'pending'`, unlaunched prepared run exactly the
 * way it would against a `'running'` one started with `engine.start()`.
 *
 * Criterion 5: the initial record is durably readable after `prepare()` and
 * before `launch()`, and abandoning a prepared handle leaves no orphaned
 * live workflow.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../../storage/memory.ts';
import {
  activity,
  workflow,
  type StartWorkflowOptions,
  type WorkflowContext,
} from '../../types.ts';
import { PREPARED_WORKFLOW_ABANDONED_REASON } from '../../types/history-policy.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { Engine } from '../index.ts';

describe('engine.prepare() / handle.launch() / handle.abandon() (COR-75)', () => {
  it('commits a durable pending record readable via engine.get() before launch(), then launches it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-simple' }).execute(async function* () {
        return 'ok';
      }),
    );

    const prepared = await engine.prepare('cor-75-simple', null, { id: 'cor-75-simple-1' });
    expect(prepared.id).toBe('cor-75-simple-1');

    // Readable through the fleet feed after phase one, before phase two.
    const recordBeforeLaunch = await engine.get(prepared.id);
    expect(recordBeforeLaunch).not.toBeNull();
    expect(recordBeforeLaunch?.status).toBe('pending');
    expect(recordBeforeLaunch?.startedAt).toBeUndefined();

    const handle = await prepared.launch();
    expect(handle.id).toBe('cor-75-simple-1');
    expect(await handle.result()).toBe('ok');

    const recordAfterCompletion = await engine.get(prepared.id);
    expect(recordAfterCompletion?.status).toBe('completed');
  });

  it('runs a real multi-step workflow to completion after launch()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const stepOne = activity({ name: 'cor-75-step-one', execute: async () => 1 });
    const stepTwo = activity({
      name: 'cor-75-step-two',
      execute: async (input: unknown) => (input as number) + 1,
    });
    const stepThree = activity({
      name: 'cor-75-step-three',
      execute: async (input: unknown) => (input as number) + 1,
    });
    engine.register(
      workflow({ name: 'cor-75-multi-step' }).execute(async function* (ctx: WorkflowContext) {
        const a = yield* ctx.run(stepOne);
        const b = yield* ctx.run(stepTwo, a);
        const c = yield* ctx.run(stepThree, b);
        return c;
      }),
    );

    const prepared = await engine.prepare('cor-75-multi-step', null, {
      id: 'cor-75-multi-step-1',
    });
    const handle = await prepared.launch();
    expect(await handle.result()).toBe(3);
  });

  it('abandoning a prepared handle before launch leaves no orphaned live workflow', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-abandoned' }).execute(async function* () {
        return 'never runs';
      }),
    );

    const prepared = await engine.prepare('cor-75-abandoned', null, {
      id: 'cor-75-abandoned-1',
    });
    const recordBeforeAbandon = await engine.get(prepared.id);
    expect(recordBeforeAbandon?.status).toBe('pending');

    await prepared.abandon();

    const recordAfterAbandon = await engine.get(prepared.id);
    expect(recordAfterAbandon?.status).toBe('cancelled');
    expect(recordAfterAbandon?.terminationReason).toBe(PREPARED_WORKFLOW_ABANDONED_REASON);

    // No orphan: the record reached a terminal status rather than staying
    // 'pending' forever, and a fresh caller-provided-id start against the
    // same id is free to proceed (would throw WorkflowAlreadyExistsError
    // against a still-active — pending/running/suspended — record).
    const restarted = await engine.start('cor-75-abandoned', null, {
      id: 'cor-75-abandoned-1',
      onTerminalConflict: 'start-new',
    });
    expect(await restarted.result()).toBe('never runs');

    // abandon() is idempotent once already abandoned.
    await expect(prepared.abandon()).resolves.toBeUndefined();
  });

  it('rejects a second launch() and rejects abandon() after launch()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-double-launch' }).execute(async function* () {
        return 'ok';
      }),
    );

    const prepared = await engine.prepare('cor-75-double-launch', null, {
      id: 'cor-75-double-launch-1',
    });
    const handle = await prepared.launch();
    await handle.result();

    await expect(prepared.launch()).rejects.toThrow(/already launched/);
    await expect(prepared.abandon()).rejects.toThrow(/already launched/);
  });

  it('same ownership/lease semantics as start(): a caller-provided id collides while prepared, exactly like an active start', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-duplicate-id' }).execute(async function* () {
        return 'ok';
      }),
    );

    await engine.prepare('cor-75-duplicate-id', null, { id: 'cor-75-duplicate-id-1' });

    await expect(
      engine.start('cor-75-duplicate-id', null, { id: 'cor-75-duplicate-id-1' }),
    ).rejects.toThrow(WorkflowAlreadyExistsError);
  });

  it('rejects options.startAt/startAfter and options.idempotencyKey', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'cor-75-rejected-options' }).execute(async function* () {
        return 'ok';
      }),
    );

    // `prepare()`'s TypeScript signature already excludes these fields; cast
    // past that to prove the RUNTIME guard also rejects them (e.g. a plain-JS
    // caller, or one that built `options` from a wider-typed value).
    const withStartAt = { startAt: Date.now() + 60_000 } as StartWorkflowOptions;
    await expect(engine.prepare('cor-75-rejected-options', null, withStartAt)).rejects.toThrow(
      /incompatible with engine.prepare/,
    );

    const withIdempotencyKey = { idempotencyKey: 'some-key' } as StartWorkflowOptions;
    await expect(
      engine.prepare('cor-75-rejected-options', null, withIdempotencyKey),
    ).rejects.toThrow(/idempotencyKey is not supported/);
  });
});
