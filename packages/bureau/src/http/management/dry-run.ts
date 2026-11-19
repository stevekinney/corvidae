/**
 * The dry run of a destructive Bureau operation: the `dryRun` input, the `{ dryRun, target,
 * effects }` answer, and the guard that keeps an operation from running for real when it is asked
 * not to.
 *
 * An operation that supports a dry run (`supportsDryRun: true`) takes the optional boolean
 * `dryRun`. With it `true` the operation does everything the real call does up to its first
 * write (its own `authorize`, the input's validation, the access check and the load of its
 * target, and the checks that would fault), so a missing target, a caller who may not touch it
 * and a stale `expectedRevision` or `expectedHash` answer the same fault the real call answers.
 * It then writes nothing, publishes no event and appends no audit record, and answers what the
 * real call would change.
 *
 * The preview is computed by the server, so it reflects the caller's authority; a dry run
 * discloses nothing the real call would not.
 *
 * @module dry-run
 */

import { z } from 'zod';

/** What a dry run's `target` names. */
export const DRY_RUN_TARGET_KINDS = [
  'task',
  'workflow-run',
  'goal',
  'context',
  'context-grants',
  'agent',
  'hook',
  'memory',
  'workflow',
  'schedule',
  'memory-embedding-switch',
] as const;

/** What one of a dry run's `effects` counts. */
export const DRY_RUN_EFFECT_KINDS = [
  'runs-in-progress',
  'running-instances',
  'schedules',
  'goals',
  'open-chats',
  'queued-runs',
  'running-switches',
  'tool-grants',
  'delivery-records',
  'deliveries-in-flight',
  'memories',
] as const;

/** The states in which a task still has a run in progress. */
export const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'submitted',
  'working',
  'input-required',
]);

/** The optional `dryRun` input an operation that supports a dry run adds to its input. */
export const dryRunField = z
  .boolean()
  .optional()
  .describe(
    'When `true`, performs the authorization and validation of the call, writes nothing, publishes no event and appends no audit record, and answers `{ dryRun: true, target, effects }` naming what the call would change. A target the real call would not find, or a caller it would refuse, answers the same fault.',
  );

const dryRunEffectSchema = z.object({
  kind: z
    .enum(DRY_RUN_EFFECT_KINDS)
    .describe('What is counted: the kind of thing the call would change besides its target.'),
  count: z.number().int().min(0).describe('How many of them the call would change.'),
  atLeast: z
    .literal(true)
    .optional()
    .describe('Present when `count` is a floor: more exist than one answer can count.'),
});

/** The answer of a dry run, whatever the operation. */
export const dryRunResultSchema = z.object({
  dryRun: z.literal(true).describe('Always `true`: nothing was changed.'),
  target: z
    .object({
      kind: z.enum(DRY_RUN_TARGET_KINDS).describe('What the call acts on.'),
      id: z.string().describe('The identifier of the target.'),
    })
    .describe('What the real call would act on.'),
  effects: z
    .array(dryRunEffectSchema)
    .describe(
      'What else the real call would change, each with a count; a kind with nothing to change is listed with a count of 0.',
    ),
});

/** One counted effect of a dry run. */
export type DryRunEffect = z.infer<typeof dryRunEffectSchema>;

/** The answer of a dry run. */
export type DryRunResult = z.infer<typeof dryRunResultSchema>;

/**
 * The answer of an operation that supports a dry run: the answer of the real call, or a
 * {@link DryRunResult}. The dry-run branch is listed first, and a real answer never carries
 * `dryRun`, so the two cannot be taken for each other.
 */
export function orDryRun<Output extends z.ZodType>(realOutput: Output) {
  return z.union([dryRunResultSchema, realOutput]);
}

/** A dry run's answer: the target the real call would act on, and what it would change. */
export function dryRunResult(
  target: DryRunResult['target'],
  effects: readonly DryRunEffect[],
): DryRunResult {
  return { dryRun: true, target, effects: effects.map((effect) => ({ ...effect })) };
}

/** An effect that counts exactly `count` things. */
export function effect(kind: DryRunEffect['kind'], count: number): DryRunEffect {
  return { kind, count };
}

/** An effect whose `count` is a floor, because the answer saw only a page of them. */
export function effectAtLeast(kind: DryRunEffect['kind'], count: number): DryRunEffect {
  return { kind, count, atLeast: true };
}
