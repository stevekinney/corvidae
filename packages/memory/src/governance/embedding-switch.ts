import {
  type MemoryEmbeddingJob,
  type MemoryEmbeddingProfile,
  type MemoryVectorReference,
  MemoryVectorProfileMissingError,
} from '../memory-vector-store';
import type { MemoryRecord } from '../types';
import type { GovernanceContext } from './governance-context';
import type { ActiveEmbedding } from './governed-embedding';
import type { MemoryEmbeddingSwitchResult } from './governed-memory-types';
import { putRecordVector } from './profile-vectors';

/** How many records one {@link advanceSwitch} embeds when its caller names no limit. */
export const DEFAULT_SWITCH_STEP_LIMIT = 500;

/** The error a switch fails with when its embedder is no longer registered, or cannot embed. */
export const TARGET_UNAVAILABLE = 'target-unavailable';

/** The error a switch fails with when its profile was deleted while it still ran. */
export const TARGET_MISSING = 'target-missing';

/** Whether two profiles are the same embedding. */
export function sameProfile(left: MemoryEmbeddingProfile, right: MemoryEmbeddingProfile): boolean {
  return (
    left.embedderId === right.embedderId &&
    left.dimension === right.dimension &&
    left.generation === right.generation
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runningRefusal(job: MemoryEmbeddingJob): MemoryEmbeddingSwitchResult {
  return {
    outcome: 'refused',
    reason: 'job-running',
    message: `A switch to the embedder "${job.target.embedderId}" is running (${job.done} of ${job.total} records); cancel it or wait for it to finish.`,
  };
}

/**
 * Deletes every profile `keep` does not name and whose generation is below `below`. Generations only
 * grow, so a profile a later switch created, in this process or another, is never one of them.
 */
async function deleteOtherProfiles(
  context: GovernanceContext,
  keep: readonly MemoryEmbeddingProfile[],
  below: number,
): Promise<void> {
  const { vectors } = context.embedding;
  for (const profile of await vectors.listProfiles()) {
    if (profile.generation >= below || keep.some((kept) => sameProfile(kept, profile))) continue;
    await vectors.deleteProfile(profile);
  }
}

/**
 * Starts a switch to the embedder registered as `id` (see `GovernedMemoryEmbedding.switchTo`). Once
 * its record is stored, the profiles that are neither active nor previous are deleted: a target a
 * crashed switch left, or one whose failure or cancellation did not finish its cleanup. The new
 * profile takes a fresh generation, so it is never one of them.
 */
export async function switchEmbedder(
  context: GovernanceContext,
  id: string,
): Promise<MemoryEmbeddingSwitchResult> {
  const { embedding } = context;
  const { vectors } = embedding;
  const availability = embedding.availability(id);
  if (availability !== 'available') {
    return {
      outcome: 'refused',
      reason: availability,
      message:
        availability === 'not-loaded'
          ? `No embedder is loaded as "${id}".`
          : `The embedder "${id}" needs setup before memory can use it.`,
    };
  }
  const existing = await vectors.getJob();
  if (existing?.state === 'running') return runningRefusal(existing);
  const from = await vectors.activeProfile(embedding.initialProfile);
  if (from.embedderId === id) {
    return {
      outcome: 'refused',
      reason: 'already-active',
      message: `Memory already embeds with "${id}".`,
    };
  }
  const { dimension } = embedding.registry.describe(id)!;
  let target: MemoryEmbeddingProfile;
  do {
    target = { embedderId: id, dimension, generation: await vectors.nextGeneration() };
  } while (!(await vectors.createProfile(target)));
  const job: MemoryEmbeddingJob = { from, target, state: 'running', done: 0, total: 0 };
  if (await vectors.replaceJob(existing, job)) {
    // Only the switch whose record was stored cleans up, so a starter that lost never deletes the
    // winner's profile. What a crash before this line leaves goes when this switch completes.
    const previous = await vectors.getPreviousProfile();
    await deleteOtherProfiles(
      context,
      previous === undefined ? [from] : [from, previous],
      target.generation,
    );
    return { outcome: 'started', target };
  }
  // Another writer replaced the switch record first; this profile is never filled.
  await vectors.deleteProfile(target);
  const current = await vectors.getJob();
  if (current?.state === 'running') return runningRefusal(current);
  return {
    outcome: 'refused',
    reason: 'job-running',
    message: 'Another switch started or ended while this one was starting; read the status again.',
  };
}

/** Moves `job` to `ended`, deleting its profile, unless the record already moved on. */
async function endSwitch(
  context: GovernanceContext,
  job: MemoryEmbeddingJob,
  ended: Pick<MemoryEmbeddingJob, 'state' | 'error'>,
): Promise<boolean> {
  const { vectors } = context.embedding;
  let current: MemoryEmbeddingJob | undefined = job;
  // The record's progress may have moved since `job` was read; the switch is the same while its
  // target is.
  while (current?.state === 'running' && sameProfile(current.target, job.target)) {
    if (await vectors.replaceJob(current, { ...current, ...ended })) {
      await vectors.deleteProfile(current.target);
      return true;
    }
    current = await vectors.getJob();
  }
  return false;
}

/** Cancels the running switch (see `GovernedMemoryEmbedding.cancel`). */
export async function cancelSwitch(context: GovernanceContext): Promise<boolean> {
  const job = await context.embedding.vectors.getJob();
  if (job?.state !== 'running') return false;
  return endSwitch(context, job, { state: 'cancelled' });
}

interface PendingRecord {
  readonly reference: MemoryVectorReference;
  readonly record: MemoryRecord;
}

/**
 * Every stored record, counted, and those `target` holds no vector for at the record's current
 * `version`. The target itself is the switch's checkpoint: a record it holds is never embedded
 * again, and one it lost (an admission whose embed into it failed, or a vector withdrawn because
 * the record changed) is pending again.
 */
async function survey(
  context: GovernanceContext,
  target: MemoryEmbeddingProfile,
): Promise<{ readonly total: number; readonly pending: readonly PendingRecord[] }> {
  let total = 0;
  const pending: PendingRecord[] = [];
  for (const scope of await context.ledger.listScopes()) {
    const records = await context.storage.list(scope);
    total += records.length;
    const held = await context.embedding.vectors.getMany(
      target,
      scope,
      records.map((record) => record.id),
    );
    for (const record of records) {
      if (held.get(record.id)?.version === record.version) continue;
      pending.push({ reference: { id: record.id, scope }, record });
    }
  }
  return { total, pending };
}

type EmbedOutcome = 'held' | 'withdrawn' | 'stopped';

/**
 * Embeds one record into the switch's target, as a write conditioned on the record: the vector is
 * written with the `version` the record had when it was read, then the record is read again, and a
 * record deleted or changed meanwhile has its vector withdrawn from the target alone. A deletion
 * that ran first is seen by that read; one that runs after it finds the vector and deletes it, so a
 * forgotten record never reappears, and a changed record is embedded again by a later survey.
 */
async function embedPending(
  context: GovernanceContext,
  target: ActiveEmbedding,
  job: MemoryEmbeddingJob,
  item: PendingRecord,
): Promise<EmbedOutcome> {
  const { vectors } = context.embedding;
  let vector: Float32Array;
  try {
    [vector] = (await target.embed([item.record.content])) as [Float32Array];
  } catch (error) {
    await endSwitch(context, job, { state: 'failed', error: messageOf(error) });
    return 'stopped';
  }
  try {
    await vectors.put(job.target, item.reference, { version: item.record.version, vector });
  } catch (error) {
    if (!(error instanceof MemoryVectorProfileMissingError)) throw error;
    // Cancelled meanwhile, which deleted the profile; otherwise something else deleted it.
    await endSwitch(context, job, { state: 'failed', error: TARGET_MISSING });
    return 'stopped';
  }
  const current = await context.storage.get(item.reference.id, item.reference.scope);
  if (current?.version === item.record.version) return 'held';
  await vectors.delete(job.target, item.reference);
  return 'withdrawn';
}

/**
 * One step of the running switch (see `GovernedMemoryEmbedding.advance`): embeds up to `limit`
 * records its target lacks, and completes it, making its target active in one compare-and-swap,
 * once a survey finds nothing pending. On completion the profiles other than the new active one and
 * the one it replaced are deleted, so the embedding two switches back goes.
 */
export async function advanceSwitch(context: GovernanceContext, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`An advance needs a positive integer limit, not ${limit}.`);
  }
  const { embedding } = context;
  const { vectors } = embedding;
  let job = await vectors.getJob();
  if (job?.state !== 'running') return;
  const registered = embedding.registry.describe(job.target.embedderId);
  if (
    registered === undefined ||
    registered.dimension !== job.target.dimension ||
    registered.availability !== 'available'
  ) {
    await endSwitch(context, job, { state: 'failed', error: TARGET_UNAVAILABLE });
    return;
  }
  const target = embedding.bind(job.target);
  let embedded = 0;
  for (;;) {
    const { total, pending } = await survey(context, job.target);
    const counted: MemoryEmbeddingJob = { ...job, done: total - pending.length, total };
    if (counted.done !== job.done || counted.total !== job.total) {
      // Cancelled, failed, or advanced by another process meanwhile: the next step reads it again.
      if (!(await vectors.replaceJob(job, counted))) return;
      job = counted;
    }
    if (pending.length === 0) {
      if (await vectors.completeJob(job))
        await deleteOtherProfiles(context, [job.target, job.from], job.target.generation);
      return;
    }
    for (const item of pending) {
      if (embedded >= limit) return;
      embedded += 1;
      const outcome = await embedPending(context, target, job, item);
      if (outcome === 'stopped') return;
      if (outcome === 'withdrawn') continue;
      const progressed: MemoryEmbeddingJob = { ...job, done: Math.min(job.done + 1, job.total) };
      if (!(await vectors.replaceJob(job, progressed))) return;
      job = progressed;
    }
    // A step that used its limit leaves completion to the next, so `done` reaches `total` first.
    if (embedded >= limit) return;
  }
}

/** Embeds `content` into `profile` and stores it as the record's vector there, fenced as admission is. */
async function embedInto(
  context: GovernanceContext,
  profile: MemoryEmbeddingProfile,
  reference: MemoryVectorReference,
  version: number,
  content: string,
): Promise<void> {
  const [vector] = (await context.embedding.bind(profile).embed([content])) as [Float32Array];
  await putRecordVector(context, profile, reference, { version, vector });
}

/**
 * After an admission stored a record and its vector in `written`, the active profile it read:
 * embeds the record into the running switch's target too, and into the active profile when a
 * switch completed after the admission read it. A failure here never fails the admission, whose
 * record is stored: the target lacks the record, so the switch embeds it before it completes.
 */
export async function embedIntoOtherProfiles(
  context: GovernanceContext,
  written: MemoryEmbeddingProfile | undefined,
  reference: MemoryVectorReference,
  version: number,
  content: string,
): Promise<void> {
  const { vectors } = context.embedding;
  const done = written === undefined ? [] : [written];
  const job = await vectors.getJob();
  for (const profile of [
    ...(job?.state === 'running' ? [job.target] : []),
    // Read after the target, so a switch that completed meanwhile is seen here at the latest.
    await vectors.getActiveProfile(),
  ]) {
    if (profile === undefined || done.some((other) => sameProfile(other, profile))) continue;
    done.push(profile);
    try {
      await embedInto(context, profile, reference, version, content);
    } catch {
      // Left for the switch: its survey finds the record missing from the target.
    }
  }
}
