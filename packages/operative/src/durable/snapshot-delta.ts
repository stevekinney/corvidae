import type { ConversationSnapshot } from 'conversationalist';

/**
 * COR-1376 — what one durable step changed in the conversation snapshot.
 *
 * A step memo's result is persisted by Weft: msgpack-encoded into the
 * checkpoint, hashed into the event log, and summarized into the timeline.
 * When that result carried the whole snapshot, every step paid for the whole
 * conversation again, so a run of N steps cost O(N²) and that encoding and
 * hashing was the largest share of a long run's time. The per-step
 * `saveConversation` activity input is persisted the same way (its timeline
 * entry stores the whole input). A delta records only what the step appended,
 * so what each step persists stays the size of one step.
 *
 * A snapshot's top-level arrays (`messages`, `nodes`, `currentPath`) only grow
 * while a step appends to a linear history. An array whose old elements are an
 * unchanged prefix of the new one is stored as its appended tail; every other
 * field, and any array a step rewrote (compaction, a branch switch), is stored
 * whole. Applying the delta to the snapshot it was taken from rebuilds the new
 * snapshot exactly, including its `integrity` digest, and refuses any other
 * base, so a replay can never apply a step to the wrong conversation.
 */
export interface ConversationSnapshotDelta {
  /** The `integrity.digest` of the snapshot this delta applies to. */
  readonly baseDigest: string;
  /** The `integrity.digest` of the snapshot this delta produces. */
  readonly digest: string;
  /** Every field of the new snapshot, in its order. */
  readonly fields: ReadonlyArray<readonly [key: string, change: SnapshotFieldChange]>;
}

/** One top-level field of the new snapshot: an appended tail, or its whole value. */
export type SnapshotFieldChange =
  | { readonly kind: 'append'; readonly retained: number; readonly appended: readonly unknown[] }
  | { readonly kind: 'set'; readonly value: unknown };

/** Structural equality for the plain JSON data a snapshot holds. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key) || !jsonEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

/**
 * The number of leading elements `next` shares with `base`. Elements usually
 * match by identity (the live conversation reuses its frozen messages), and
 * the structural comparison covers the ones a snapshot rebuilds.
 */
function sharedPrefixLength(base: readonly unknown[], next: readonly unknown[]): number {
  const limit = Math.min(base.length, next.length);
  let index = 0;
  while (index < limit && jsonEqual(base[index], next[index])) index += 1;
  return index;
}

function fieldChange(baseValue: unknown, nextValue: unknown): SnapshotFieldChange {
  if (Array.isArray(baseValue) && Array.isArray(nextValue)) {
    const retained = sharedPrefixLength(baseValue, nextValue);
    // Only a field that kept all of its old elements is a pure append.
    if (retained === baseValue.length) {
      return { kind: 'append', retained, appended: nextValue.slice(retained) };
    }
  }
  return { kind: 'set', value: nextValue };
}

/** The delta that turns `base` into `next`. */
export function diffConversationSnapshot(
  base: ConversationSnapshot,
  next: ConversationSnapshot,
): ConversationSnapshotDelta {
  const baseRecord = base as unknown as Record<string, unknown>;
  return {
    baseDigest: base.integrity.digest,
    digest: next.integrity.digest,
    fields: Object.entries(next).map(
      ([key, value]) =>
        [
          key,
          fieldChange(Object.hasOwn(baseRecord, key) ? baseRecord[key] : undefined, value),
        ] as const,
    ),
  };
}

/**
 * Rebuilds the snapshot a delta describes from the snapshot it was taken
 * from. Throws when `base` is not that snapshot.
 */
export function applyConversationSnapshotDelta(
  base: ConversationSnapshot,
  delta: ConversationSnapshotDelta,
): ConversationSnapshot {
  if (base.integrity.digest !== delta.baseDigest) {
    throw new Error(
      `Durable run conversation delta expects base snapshot ${delta.baseDigest}, ` +
        `but the run's snapshot is ${base.integrity.digest}. The run's replay diverged ` +
        'from its recorded history.',
    );
  }
  const baseRecord = base as unknown as Record<string, unknown>;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, change] of delta.fields) {
    if (change.kind === 'set') {
      rebuilt[key] = change.value;
      continue;
    }
    const baseValue = Object.hasOwn(baseRecord, key) ? baseRecord[key] : undefined;
    if (!Array.isArray(baseValue) || baseValue.length !== change.retained) {
      throw new Error(
        `Durable run conversation delta expects ${change.retained} retained "${key}" entries.`,
      );
    }
    rebuilt[key] = [...baseValue, ...change.appended];
  }
  return rebuilt as unknown as ConversationSnapshot;
}
