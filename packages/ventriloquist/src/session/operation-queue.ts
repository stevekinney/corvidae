/**
 * The host FIFO for input and resize operations, with capacity held back for control work.
 * User operations may fill `userLimit` entries and no more, so a full FIFO can never consume the
 * `controlReserve` that stop, revoke and cleanup are admitted against. Control work is not queued
 * behind user operations: admitting it only claims a slot of the reserve until it is released.
 */
export class OperationQueue<Item> {
  readonly #userLimit: number;
  readonly #controlReserve: number;
  readonly #items: Item[] = [];
  #controlAdmitted = 0;

  constructor(userLimit: number, controlReserve: number) {
    this.#userLimit = userLimit;
    this.#controlReserve = controlReserve;
  }

  get userSize(): number {
    return this.#items.length;
  }

  get controlAdmitted(): number {
    return this.#controlAdmitted;
  }

  /** Queue a user operation unless the user capacity is used up. A refused operation is never queued. */
  offerUser(item: Item): boolean {
    if (this.#items.length >= this.#userLimit) return false;
    this.#items.push(item);
    return true;
  }

  /** The oldest queued user operation, removed from the queue. */
  take(): Item | undefined {
    return this.#items.shift();
  }

  /** Remove and return every queued user operation, oldest first. */
  drain(): Item[] {
    return this.#items.splice(0);
  }

  /** Claim one slot of the reserved control capacity, or `undefined` when all of it is in use. */
  admitControl(): (() => void) | undefined {
    if (this.#controlAdmitted >= this.#controlReserve) return undefined;
    this.#controlAdmitted += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#controlAdmitted -= 1;
    };
  }
}
