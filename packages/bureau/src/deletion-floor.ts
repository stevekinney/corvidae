/**
 * The sequence at or below which a session id's durable events are not the live
 * session's (COR-718). The id's history holds every incarnation of the id, each
 * ended by a `session.deleted` marker, so the live session's own events are those
 * after the latest marker. A subscription judges events one at a time while the id
 * can be deleted and recreated underneath it, so the floor is tied to the
 * incarnation it was read for and read again when the live incarnation changes.
 *
 * @module deletion-floor
 */

export type DeletionFloor = {
  /** The floor for `incarnation`, read through `lookup` the first time and whenever the incarnation differs from the last. */
  floorFor(incarnation: string): Promise<number>;
  /** Raises the floor to a marker the stream itself delivered. */
  raise(sequence: number): void;
};

/**
 * @param lookup Reads the latest deletion marker's sequence, or `-1` when there is none.
 *   A lookup that throws caches nothing, so the next event reads it afresh.
 */
export function createDeletionFloor(lookup: () => Promise<number>): DeletionFloor {
  let current: { readonly incarnation: string; sequence: number } | undefined;
  return {
    async floorFor(incarnation) {
      if (current?.incarnation !== incarnation) {
        current = undefined;
        current = { incarnation, sequence: await lookup() };
      }
      return current.sequence;
    },
    raise(sequence) {
      if (current !== undefined) current.sequence = Math.max(current.sequence, sequence);
    },
  };
}
