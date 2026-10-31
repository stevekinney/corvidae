/**
 * What enabling the demo plugin leaves in a host besides its agents: one schedule and one goal.
 * They are Bureau state, so {@link seedDemo} creates them once, under one claim on a record in the
 * plugin's scoped storage (`plugin:demo:seeded-schedule`), and a restart adds nothing. A schedule's
 * fire runs its named agent, so the seeded schedule runs `demo:assistant`'s script.
 *
 * @module seed
 */

import type { PluginHostApi } from '@lostgradient/interborough-plugin';
import {
  textValueStore,
  type ConditionalTextValueStore,
  type Storage,
} from '@lostgradient/storage';

import { ACCEPTS_ANY_ANSWER } from './validators.ts';

/** The description the seeded schedule is created with. */
export const SEEDED_SCHEDULE_DESCRIPTION = 'Daily summary';

/** The goal the seed creates. */
export const SEEDED_GOAL_RUN_IDENTIFIER = 'seeded-goal';

/**
 * The key of the record, in the plugin's scoped storage, of the seeded schedule's identifier. The
 * backing store holds it as `plugin:demo:seeded-schedule`. A schedule is edited and renamed by
 * operators, so nothing about it but its identifier says it is the seeded one. While a start is
 * creating the schedule the record holds `claimed:<uuid>` instead.
 */
export const SEEDED_SCHEDULE_KEY = 'seeded-schedule';

/** The seeded schedule was created, but the record no longer held this start's claim to be replaced by its identifier. */
export class DemoScheduleRecordLostError extends Error {
  constructor(scheduleId: string) {
    super(
      `Seeded schedule ${scheduleId} was created, but its claim on the "${SEEDED_SCHEDULE_KEY}" record was replaced first, so the record does not name it.`,
    );
    this.name = 'DemoScheduleRecordLostError';
  }
}

/**
 * The identifier `schedules.create` reports when the schedule is registered and only its summary
 * could not be read (Bureau's `ScheduleLocatorUnavailableError`). The plugin cannot import Bureau,
 * so the error is recognised by its `code` and its `scheduleId`.
 */
function registeredScheduleOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, scheduleId } = error as Error & { code?: unknown; scheduleId?: unknown };
  return code === 'ScheduleLocatorUnavailableError' && typeof scheduleId === 'string'
    ? scheduleId
    : undefined;
}

/**
 * Create the seeded schedule and goal unless they already exist. The schedule is recognised by the
 * identifier recorded when it was created, so an operator who renames or edits it, or deletes it,
 * does not get a second one on the next start.
 *
 * Every change to the record is a conditional write, so starts that overlap, in one process or two
 * over one database, create the schedule once: only the start whose write of `claimed:<uuid>`
 * finds the record absent creates it. It then replaces its claim with the identifier. When the
 * schedule is not created (`create` throws, or returns `undefined`) it removes its claim, and only
 * its own, so the next start tries again. When `create` reports that the schedule is registered and
 * only its summary could not be read, the start records that identifier in place of its claim and
 * carries on.
 *
 * The seeded goal is created under the same claim: only the start that won it creates the goal,
 * and only after the schedule's outcome is settled, so a second host never loses the goal's
 * controller claim and logs it as an error. A start that loses the claim creates neither. The
 * accepted window is the claim's own: a crash after the claim and before the goal exists leaves the
 * record present, so no later start creates the goal, and a goal whose creation throws is not
 * retried either. Both leave the install without its seeded goal, the same as a crash leaves it
 * without its schedule. A start that finds a `claimed:` record left behind reports it through
 * `warn`. A rejection from here marks the plugin failed; the host keeps running.
 *
 * @param host The host API `afterStart` received.
 * @param storage The plugin's scoped storage.
 * @param warn Receives a possibly stale claim. Defaults to `console.warn`.
 */
export async function seedDemo(
  host: PluginHostApi,
  storage: Storage,
  // The plugin has no logger, so a stale claim is reported on the console the host runs on.
  // eslint-disable-next-line no-console
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  // `disposeUnderlyingStorage: false` because the plugin's storage outlives this call: nothing here closes it.
  const records = textValueStore(storage, { disposeUnderlyingStorage: false });
  const key = SEEDED_SCHEDULE_KEY;
  const claim = `claimed:${crypto.randomUUID()}`;
  // Accepted window: a crash after this claim and before the identifier below is written leaves the
  // claim behind, and every later start finds the record present, so the install has no seeded
  // schedule (when the crash came before `create` returned) or an unrecorded one (after). Nothing
  // recovers a claim, because a claim cannot be told from one a live start is still using.
  const claimed = await records.conditionalBatch(
    [{ key, expectedValue: null }],
    [{ type: 'put', key, value: claim }],
  );
  if (!claimed) {
    // A start that lost the claim leaves both the schedule and the goal to the one that won it.
    const held = await records.get(key);
    if (held?.startsWith('claimed:') === true) {
      warn(
        `The "${key}" record holds a claim. It is stale only if no other host is starting right now: a start that crashed after claiming it never seeds the schedule or the goal, and nothing removes the claim. Delete the "plugin:demo:${key}" record to seed again.`,
      );
    }
    return;
  }
  let scheduleId: string | undefined;
  try {
    const created = await host.schedules.create({
      description: SEEDED_SCHEDULE_DESCRIPTION,
      agentName: 'demo:assistant',
      input: 'Summarize what happened yesterday.',
      spec: '0 9 * * *',
    });
    scheduleId = created?.id;
  } catch (error) {
    const registered = registeredScheduleOf(error);
    if (registered === undefined) {
      await releaseClaim(records, key, claim);
      throw error;
    }
    // The schedule is registered, so releasing the claim would seed a duplicate on the next start.
    scheduleId = registered;
  }
  if (scheduleId === undefined) {
    await releaseClaim(records, key, claim);
  } else {
    const recorded = await records.conditionalBatch(
      [{ key, expectedValue: claim }],
      [{ type: 'put', key, value: scheduleId }],
    );
    if (!recorded) throw new DemoScheduleRecordLostError(scheduleId);
  }
  await host.goals.create({
    goalRunId: SEEDED_GOAL_RUN_IDENTIFIER,
    agentName: 'demo:assistant',
    prompt: 'Say hello.',
    identity: { name: 'say-hello', version: '1' },
    validator: { name: `demo:${ACCEPTS_ANY_ANSWER.name}`, version: ACCEPTS_ANY_ANSWER.version },
    bounds: { maximumAttempts: 1, maximumTotalSteps: 10 },
  });
}

/**
 * Remove `claim` from the record, and only if the record still holds it. A failure to remove it
 * leaves the claim, which is the accepted window above, so it does not hide the error that sent the
 * start here.
 */
async function releaseClaim(
  records: ConditionalTextValueStore,
  key: string,
  claim: string,
): Promise<void> {
  try {
    await records.conditionalBatch([{ key, expectedValue: claim }], [{ type: 'delete', key }]);
  } catch {
    // The caller rethrows the error that made the claim worth releasing.
  }
}
