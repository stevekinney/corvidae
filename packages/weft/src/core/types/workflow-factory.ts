/**
 * `createWorkflowFactory` — one shared set of activities, signals, updates, and
 * queries that every workflow built from the factory declares as its own.
 *
 * The factory does not register anything. Each builder it returns starts with
 * the shared entries already in its maps, so `.execute(fn)` freezes them into
 * the workflow definition exactly as if the workflow had declared them with
 * `.activities({...})` and `.signals({...})`. Registration, per-workflow
 * activity resolution, listings, and contracts see them through the existing
 * per-workflow path; there is no extra registry.
 */

import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import type {
  ActivityMap,
  ActivityMapInput,
  NormalizeActivities,
  QueryMap,
  SignalMap,
  UpdateMap,
} from './workflow-builder-helpers.ts';
import {
  normalizeActivityMap,
  type SharedWorkflowEntries,
  type WorkflowBuilderOptions,
} from './workflow-builder-runtime.ts';
import type { InitialBuilderState, WorkflowBuilder } from './workflow-builder.ts';
import { createWorkflowBuilder } from './workflow-function.ts';

/**
 * The shared entries passed to {@link createWorkflowFactory}. Each map takes
 * the same shapes as the matching builder method: `activities` accepts what
 * `.activities({...})` accepts, `signals` what `.signals({...})` accepts, and
 * so on. Every map is optional.
 *
 * @example
 * ```ts
 * import { signal, type SignalDefinition, type WorkflowFactoryEntries } from '@lostgradient/weft';
 *
 * const entries: WorkflowFactoryEntries<
 *   { greet: (name: string) => Promise<string> },
 *   { approve: SignalDefinition<{ approverId: string }> }
 * > = {
 *   activities: { greet: async (name) => `Hello, ${name}` },
 *   signals: { approve: signal<{ approverId: string }>('approve') },
 * };
 * void entries;
 * ```
 */
export interface WorkflowFactoryEntries<
  TActivities extends ActivityMapInput = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
> {
  readonly activities?: TActivities;
  readonly signals?: TSignals;
  readonly updates?: TUpdates;
  readonly queries?: TQueries;
}

/**
 * The value {@link createWorkflowFactory} returns. Its `workflow` takes the
 * same options as the standalone `workflow({ name })` and returns a builder
 * whose `ctx.run`, `ctx.waitForSignal`, `ctx.waitForUpdate`, and query maps
 * already know the shared entries. `workflow` is a plain function, so it can
 * be destructured.
 *
 * @example
 * ```ts
 * import { createWorkflowFactory, type WorkflowFactory } from '@lostgradient/weft';
 *
 * // A factory with no shared entries builds the same workflows `workflow()` does.
 * const factory: WorkflowFactory = createWorkflowFactory({});
 * const job = factory.workflow({ name: 'job' }).execute(async function* () {
 *   return 'done';
 * });
 * void job;
 * ```
 */
export interface WorkflowFactory<
  TActivities extends ActivityMap = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
> {
  readonly workflow: <const TName extends string>(
    options: WorkflowBuilderOptions<TName>,
  ) => WorkflowBuilder<TName, TActivities, TSignals, TUpdates, TQueries, {}, InitialBuilderState>;
}

/**
 * Declare activities, signals, updates, and queries once and share them across
 * many workflows. Every workflow built with the returned `workflow` gets typed
 * `ctx.run('name', input)`, `ctx.waitForSignal('name')`, and the rest for the
 * shared entries, and can still add its own with `.activities({...})`,
 * `.signals({...})`, `.updates({...})`, and `.queries({...})`. The two sets
 * merge. A workflow cannot redeclare a name the factory already declares:
 * that is a type error and throws `WorkflowBuilderError` at runtime, so a
 * shared name means the same thing in every workflow.
 *
 * The shared entries become each workflow's own, so they appear in that
 * workflow's activity and signal listings and contract, and
 * `Engine.create({ workflows })` registers them with the workflow. Nothing
 * else needs registering. Activity entries are validated here, so a bad name
 * fails at the factory, not at the first workflow.
 *
 * @example
 * ```ts
 * import { createWorkflowFactory, Engine, signal } from '@lostgradient/weft';
 *
 * const { workflow } = createWorkflowFactory({
 *   activities: { greet: async (name: string) => `Hello, ${name}` },
 *   signals: { approve: signal<{ approverId: string }>('approve') },
 * });
 *
 * const welcome = workflow({ name: 'welcome' })
 *   .activities({ shout: async (text: string) => text.toUpperCase() })
 *   .execute(async function* (ctx, name: string) {
 *     const greeting = yield* ctx.run('greet', name);
 *     const { approverId } = yield* ctx.waitForSignal('approve');
 *     return { greeting: yield* ctx.run('shout', greeting), approverId };
 *   });
 *
 * const farewell = workflow({ name: 'farewell' }).execute(async function* (ctx, name: string) {
 *   return yield* ctx.run('greet', name);
 * });
 *
 * const engine = await Engine.create({ workflows: { welcome, farewell }, recover: false });
 * void engine;
 * ```
 */
export function createWorkflowFactory<
  TActivities extends ActivityMapInput = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
>(
  entries: WorkflowFactoryEntries<TActivities, TSignals, TUpdates, TQueries>,
): WorkflowFactory<NormalizeActivities<TActivities>, TSignals, TUpdates, TQueries> {
  // Normalise and copy once, so later mutation of the caller's maps cannot
  // change what the factory's workflows declare.
  const shared: SharedWorkflowEntries = {
    activities: normalizeActivityMap(entries.activities ?? {}),
    signals: { ...(entries.signals as Record<string, SignalDefinition<unknown>> | undefined) },
    updates: { ...(entries.updates as Record<string, UpdateDefinition> | undefined) },
    queries: { ...(entries.queries as Record<string, QueryDefinition> | undefined) },
  };

  return Object.freeze({
    workflow: <const TName extends string>(options: WorkflowBuilderOptions<TName>) =>
      createWorkflowBuilder(options, shared) as unknown as WorkflowBuilder<
        TName,
        NormalizeActivities<TActivities>,
        TSignals,
        TUpdates,
        TQueries,
        {},
        InitialBuilderState
      >,
  });
}
