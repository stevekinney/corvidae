// Type contracts for `createWorkflowFactory` and the merge semantics it gives
// the builder's chain methods. Every assertion is either an
// `Equals<actual, expected> = true` line or an `@ts-expect-error` on a line
// that must fail to compile.

import { Engine, type WorkflowHandle } from '../../../index.ts';
import { query, signal, update } from '../message-handles.ts';
import type { MergeMaps, NormalizeActivities } from '../workflow-builder-helpers.ts';
import { createWorkflowFactory } from '../workflow-factory.ts';
import { workflow as plainWorkflow } from '../workflow-function.ts';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// ---------------------------------------------------------------------------
// MergeMaps — merging onto an empty map is the identity, so plain builders
// keep exactly the types they had before chain methods merged.
// ---------------------------------------------------------------------------

type Own = NormalizeActivities<{ greet: (name: string) => Promise<string> }>;
const _check_merge_identity: Equals<MergeMaps<{}, Own>, Own> = true;
const _check_merge_union: Equals<MergeMaps<{ a: 1 }, { b: 2 }>, { a: 1; b: 2 }> = true;
// A wide map has no known names to merge, so the added map replaces it.
const _check_merge_wide: Equals<MergeMaps<Record<string, 1>, { b: 2 }>, { b: 2 }> = true;
void _check_merge_identity;
void _check_merge_union;
void _check_merge_wide;

const plain = plainWorkflow({ name: 'plain' })
  .activities({ greet: async (name: string) => `Hello, ${name}` })
  .execute(async function* (ctx, name: string) {
    return yield* ctx.run('greet', name);
  });
const _check_plain_activities: Equals<NonNullable<typeof plain._activities>, Own> = true;
void _check_plain_activities;

// ---------------------------------------------------------------------------
// Shared entries are typed in every workflow the factory builds.
// ---------------------------------------------------------------------------

const approve = signal<{ approverId: string }>('approve');

const { workflow } = createWorkflowFactory({
  activities: { greet: async (name: string) => `Hello, ${name}` },
  signals: { approve },
  updates: { rename: update<string, boolean>('rename') },
  queries: { progress: query<void, number>('progress') },
});

const welcome = workflow({ name: 'welcome' }).execute(async function* (ctx, name: string) {
  const greeting = yield* ctx.run('greet', name);
  const _check_greeting: Equals<typeof greeting, string> = true;
  void _check_greeting;

  // @ts-expect-error — `greet` takes a string.
  yield* ctx.run('greet', 42);

  const decision = yield* ctx.waitForSignal('approve');
  const _check_signal: Equals<typeof decision, { approverId: string }> = true;
  void _check_signal;

  const renamed = yield* ctx.waitForUpdate('rename');
  const _check_update: Equals<typeof renamed.payload, string> = true;
  void _check_update;
  renamed.respond(true);

  ctx.onQuery('progress', () => 0.5);

  return { greeting, approverId: decision.approverId };
});

const _check_welcome_name: Equals<typeof welcome.name, 'welcome'> = true;
void _check_welcome_name;

// ---------------------------------------------------------------------------
// A workflow's own entries merge with the shared ones.
// ---------------------------------------------------------------------------

const merged = workflow({ name: 'merged' })
  .activities({ shout: async (text: string) => text.toUpperCase() })
  .signals({ reject: signal<{ reason: string }>('reject') })
  .execute(async function* (ctx, name: string) {
    const greeting = yield* ctx.run('greet', name);
    const shouted = yield* ctx.run('shout', greeting);
    const _check_shouted: Equals<typeof shouted, string> = true;
    void _check_shouted;

    const approval = yield* ctx.waitForSignal('approve');
    const rejection = yield* ctx.waitForSignal('reject');
    const _check_approval: Equals<typeof approval, { approverId: string }> = true;
    const _check_rejection: Equals<typeof rejection, { reason: string }> = true;
    void _check_approval;
    void _check_rejection;
    return shouted;
  });

const _check_merged_activities: Equals<
  keyof NonNullable<typeof merged._activities>,
  'greet' | 'shout'
> = true;
const _check_merged_signals: Equals<
  keyof NonNullable<typeof merged._signals>,
  'approve' | 'reject'
> = true;
void _check_merged_activities;
void _check_merged_signals;

// ---------------------------------------------------------------------------
// Conflicting names are rejected, and each chain method is still once-only.
// ---------------------------------------------------------------------------

workflow({ name: 'conflict' })
  // @ts-expect-error — `greet` is already declared by the factory.
  .activities({ greet: async (name: string) => name });

workflow({ name: 'conflict' })
  // @ts-expect-error — `approve` is already declared by the factory.
  .signals({ approve });

workflow({ name: 'conflict' })
  // @ts-expect-error — `rename` is already declared by the factory.
  .updates({ rename: update<string, boolean>('rename') });

workflow({ name: 'conflict' })
  // @ts-expect-error — `progress` is already declared by the factory.
  .queries({ progress: query<void, number>('progress') });

workflow({ name: 'once' })
  .activities({ shout: async (text: string) => text })
  // @ts-expect-error — `.activities()` is once-only, factory or not.
  .activities({ whisper: async (text: string) => text });

// ---------------------------------------------------------------------------
// Engine.create registers factory workflows with no extra step.
// ---------------------------------------------------------------------------

async function assertEngineCreateTypesFactoryWorkflows(): Promise<void> {
  const engine = await Engine.create({ workflows: { welcome, merged } });
  const welcomeHandle: WorkflowHandle<{ greeting: string; approverId: string }> =
    await engine.start('welcome', 'Ada');
  const mergedHandle: WorkflowHandle<string> = await engine.start('merged', 'Grace');
  // @ts-expect-error — `merged` takes a string.
  await engine.start('merged', 42);
  void welcomeHandle;
  void mergedHandle;
}
void assertEngineCreateTypesFactoryWorkflows;
