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
import { evictCachedContent, putRecordVector } from './profile-vectors';

/** How many records one `memory.embedding.advance()` embeds when its caller names no limit. */
export const DEFAULT_SWITCH_STEP_LIMIT = 500;

/**
 * How long a queued embed whose record is not stored is kept, in milliseconds. An admission while
 * the active embedder is unavailable queues its record before storing it, and between the two it
 * makes one record write, so an entry this old whose record is still absent belongs to an admission
 * that stopped before storing it, or to a record forgotten since. A record write that outlives this
 * is stalled storage, not a slow admission. Generous, so the clocks of processes that share the
 * store may disagree by minutes.
 */
export const QUEUED_EMBED_GRACE_MILLISECONDS = 15 * 60 * 1000;

/** The error a switch fails with when its embedder is no longer registered, or cannot embed. */
export const TARGET_UNAVAILABLE = 'target-unavailable';

/** The error a switch fails with when its profile was deleted while it still ran. */
export const TARGET_MISSING = 'target-missing';

/**
 * How many times a start reads again after another writer moved the switch record or the active
 * profile first. Each loss needs another switch to have started, ended, or completed meanwhile.
 */
const SWITCH_START_ATTEMPTS = 8;

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
  await vectors.resumeProfileDeletions();
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
 *
 * The record is stored only while the switch record and the active profile are still what this
 * start read. A start that lost to another writer deletes the profile it created and reads again,
 * so it never records a switch from an embedding another switch replaced meanwhile, whose cleanup
 * would delete the new active profile and which could never complete.
 */
export async function switchEmbedder(
  context: GovernanceContext,
  id: string,
): Promise<MemoryEmbeddingSwitchResult> {
  const { embedding } = context;
  const { vectors } = embedding;
  for (let attempt = 0; attempt < SWITCH_START_ATTEMPTS; attempt++) {
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
    if (await vectors.startJob(existing, job)) {
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
    // Another writer moved the switch record or the active profile first; this profile is never
    // filled.
    await vectors.deleteProfile(target);
  }
  return {
    outcome: 'refused',
    reason: 'job-running',
    message:
      'Other switches kept starting or ending while this one was starting; read the status again.',
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
 * Writes `vector` as the record's vector in `profile`, conditioned on the record: the vector carries
 * the `version` the record had when it was read, then the record is read again, and a record
 * deleted or changed meanwhile has its vector withdrawn from `profile` alone. A deletion that ran
 * first is seen by that read; one that runs after it finds the vector and deletes it, so a
 * forgotten record never reappears, and a changed record is embedded again later. Throws
 * {@link MemoryVectorProfileMissingError} when the store no longer holds `profile`.
 */
async function putConditioned(
  context: GovernanceContext,
  profile: MemoryEmbeddingProfile,
  item: PendingRecord,
  vector: Float32Array,
): Promise<'held' | 'withdrawn' | 'deleted'> {
  const { vectors } = context.embedding;
  await vectors.put(profile, item.reference, { version: item.record.version, vector });
  const current = await context.storage.get(item.reference.id, item.reference.scope);
  if (current?.version === item.record.version) return 'held';
  await vectors.delete(profile, item.reference);
  if (current !== undefined) return 'withdrawn';
  // A deleted record's `caches` target may have run before this embed cached its content again.
  await evictCachedContent(context, item.record.content);
  return 'deleted';
}

/**
 * Embeds one record into the switch's target, as a write conditioned on the record (see
 * `putConditioned`). An embedder that errors fails the switch, and so does a target deleted
 * meanwhile.
 */
async function embedPending(
  context: GovernanceContext,
  target: ActiveEmbedding,
  job: MemoryEmbeddingJob,
  item: PendingRecord,
): Promise<EmbedOutcome> {
  let vector: Float32Array;
  try {
    [vector] = (await target.embed([item.record.content])) as [Float32Array];
  } catch (error) {
    await endSwitch(context, job, { state: 'failed', error: messageOf(error) });
    return 'stopped';
  }
  try {
    return (await putConditioned(context, job.target, item, vector)) === 'held'
      ? 'held'
      : 'withdrawn';
  } catch (error) {
    if (!(error instanceof MemoryVectorProfileMissingError)) throw error;
    // Cancelled meanwhile, which deleted the profile; otherwise something else deleted it.
    await endSwitch(context, job, { state: 'failed', error: TARGET_MISSING });
    return 'stopped';
  }
}

/**
 * Where each memory's queue drain stopped: the profile it drained and the last entry it read. The
 * next step reads on from there, so an entry whose embed keeps failing takes one attempt per pass
 * through the queue instead of the front of every step. Held in the process, because losing it
 * only starts the next pass from the front.
 */
const queueCursors = new WeakMap<
  GovernanceContext,
  { readonly profile: MemoryEmbeddingProfile; readonly after: MemoryVectorReference }
>();

/**
 * Embeds up to `limit` records queued for the active profile, and returns how many it embedded. A
 * record is queued when it was admitted while the active embedder was unavailable, or when its
 * embed into a running switch's target, or into a profile a switch made active meanwhile, failed or
 * never finished; once that profile is active, this embeds it. Nothing runs while the active
 * embedder is unavailable. Each step reads on from the entry the last one stopped at, wrapping to
 * the front, so every entry is attempted in turn. An entry whose record already has its vector at
 * its current `version` is dropped without an embed, and so is one whose record is absent once the
 * entry is older than {@link QUEUED_EMBED_GRACE_MILLISECONDS}; a younger one may belong to an
 * admission that has queued its record and not stored it yet, and stays. An entry whose embed
 * errors stays queued for a later pass.
 */
async function embedQueued(context: GovernanceContext, limit: number): Promise<number> {
  const { embedding } = context;
  const { vectors } = embedding;
  const profile = await vectors.getActiveProfile();
  if (profile === undefined || limit < 1 || !embedding.canEmbed(profile)) return 0;
  const active = embedding.bind(profile);
  const cursor = queueCursors.get(context);
  const after =
    cursor !== undefined && sameProfile(cursor.profile, profile) ? cursor.after : undefined;
  let embedded = 0;
  for (const { reference, queuedAt } of await vectors.listQueuedEmbeds(profile, limit, after)) {
    queueCursors.set(context, { profile, after: reference });
    const record = await context.storage.get(reference.id, reference.scope);
    if (record === undefined && context.now() - queuedAt <= QUEUED_EMBED_GRACE_MILLISECONDS) {
      continue;
    }
    const held =
      record === undefined
        ? undefined
        : await vectors.getMany(profile, reference.scope, [reference.id]);
    if (record !== undefined && held?.get(reference.id)?.version !== record.version) {
      embedded += 1;
      let vector: Float32Array;
      try {
        [vector] = (await active.embed([record.content])) as [Float32Array];
      } catch {
        continue;
      }
      let outcome: Awaited<ReturnType<typeof putConditioned>>;
      try {
        outcome = await putConditioned(context, profile, { reference, record }, vector);
      } catch (error) {
        if (!(error instanceof MemoryVectorProfileMissingError)) throw error;
        // A switch completed meanwhile and replaced this profile; the next step reads the new one.
        return embedded;
      }
      // A record changed meanwhile stays queued, and is embedded at its new `version` next step.
      if (outcome === 'withdrawn') continue;
    }
    await vectors.dequeueEmbed(profile, reference);
  }
  return embedded;
}

/**
 * One step of `memory.embedding.advance()`: finishes any profile deletion a stopped process or a
 * failed write left part-way, embeds records queued for the active profile, then advances the
 * running switch, `limit` embeds in all.
 */
export async function advanceEmbedding(context: GovernanceContext, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`An advance needs a positive integer limit, not ${limit}.`);
  }
  // Each step, a switch running or not, finishes a profile deletion that stopped part-way.
  await context.embedding.vectors.resumeProfileDeletions();
  const embedded = await embedQueued(context, limit);
  await advanceSwitch(context, limit - embedded);
}

/**
 * One step of the running switch (see `GovernedMemoryEmbedding.advance`): embeds up to `limit`
 * records its target lacks, and completes it, making its target active in one compare-and-swap,
 * once a survey finds nothing pending. A `limit` of 0 still counts the switch's progress, and
 * completes it when nothing is pending. On completion the profiles other than the new active one
 * and the one it replaced are deleted, so the embedding two switches back goes.
 */
async function advanceSwitch(context: GovernanceContext, limit: number): Promise<void> {
  const { embedding } = context;
  const { vectors } = embedding;
  let job = await vectors.getJob();
  if (job?.state !== 'running') return;
  if (!embedding.canEmbed(job.target)) {
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
  await putRecordVector(context, profile, reference, { version, vector }, content);
}

/**
 * After an admission stored a record and its vector in `written`, the active profile it read (or
 * queued the record for it, while its embedder was unavailable): embeds the record into the running
 * switch's target too, and into the active profile when a switch completed after the admission read
 * it. Each embed is queued first and dequeued once its vector is stored, so a failure, or a process
 * that stops part-way, leaves it queued. A failure here never fails the admission, whose record is
 * stored: the switch embeds what its target lacks before it completes, and a step embeds a queued
 * record into the active profile, which covers a record stored after the switch's last survey whose
 * embed into its target failed before the switch completed.
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
      // A profile deleted meanwhile refuses the entry; there is nothing to embed into then.
      if (!(await vectors.enqueueEmbed(profile, reference, context.now()))) continue;
      if (!context.embedding.canEmbed(profile)) continue;
      await embedInto(context, profile, reference, version, content);
      await vectors.dequeueEmbed(profile, reference);
    } catch {
      // The entry stays queued: a step embeds it once the profile is active, and a running
      // switch's survey finds the record missing from its target before then.
    }
  }
}
