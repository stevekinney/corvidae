/**
 * What Bureau records about one schedule fire (COR-718): the fire's run is owned by
 * its schedule's owner, and the scheduler is only the actor on the `schedule.fired`
 * audit entry. Both are recorded when the fire's services are built, which can
 * happen more than once for one fire (recovery, or two instances during a lease
 * handoff), so the entry is written through an atomic `dedupeKey` and the
 * attribution is released when the fire settles.
 *
 * @module scheduled-fire-record
 */

import type { AuditTrail } from './audit-trail';
import { SCHEDULER_ACTOR } from './owner-of-record';
import type { ScheduledFireNotice } from './runtime-composition';
import type { RunAttribution } from './serialization';

/**
 * Attributes the fire's run to its schedule's owner. The entry lives only while the
 * run does: {@link releaseScheduledFire} removes it when the fire settles, after
 * which the owner is read durably through the schedule, so a recurring schedule
 * does not grow the map by one entry per tick.
 */
export function attributeScheduledFire(
  runAttribution: Map<string, RunAttribution>,
  firedRunIds: Set<string>,
  fire: ScheduledFireNotice,
): void {
  runAttribution.set(fire.runId, {
    ...runAttribution.get(fire.runId),
    agentName: fire.agentName,
    principal: fire.owner,
  });
  firedRunIds.add(fire.runId);
}

/** Forgets a fire's attribution once its run has settled. Anything not recorded by a fire is left alone. */
export function releaseScheduledFire(
  runAttribution: Map<string, RunAttribution>,
  firedRunIds: Set<string>,
  runId: string,
): void {
  if (!firedRunIds.delete(runId)) return;
  runAttribution.delete(runId);
}

/**
 * Writes the fire's `schedule.fired` entry, once however many times the fire is
 * rebuilt: the write carries a `dedupeKey` derived from the fire's run id, which the
 * audit trail commits atomically with the entry.
 */
export async function recordScheduleFired(
  trail: AuditTrail,
  fire: ScheduledFireNotice,
): Promise<void> {
  await trail.record({
    runId: fire.runId,
    type: 'schedule.fired',
    detail: {
      scheduleId: fire.scheduleId ?? null,
      sessionId: fire.sessionId,
      agentName: fire.agentName,
    },
    principal: SCHEDULER_ACTOR,
    dedupeKey: `schedule.fired:${fire.runId}`,
  });
}
