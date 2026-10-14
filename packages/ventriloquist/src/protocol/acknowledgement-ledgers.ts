import { accept, reject, type ProtocolResult } from './protocol-failure.ts';

/**
 * Tracks the input and resize operations of one attachment. An operation is unresolved from the
 * moment it is submitted until it is acknowledged (accepted into the host FIFO) or failed before
 * it was queued. Resolutions arrive in submission order, so each must name the oldest unresolved
 * operation: anything else is stale, duplicate, from the future, or out of order. An acknowledgement
 * says only that the operation was accepted; it never claims the child consumed or ran it.
 */
export class OperationLedger {
  #unresolved: number[];
  #lastResolved: number;
  #highestSubmitted: number;
  /** Every sequence that was ever an operation: sequences of other messages are never in it. */
  readonly #submitted: Set<number>;

  constructor() {
    this.#unresolved = [];
    this.#lastResolved = 0;
    this.#highestSubmitted = 0;
    this.#submitted = new Set();
  }

  get unresolvedCount(): number {
    return this.#unresolved.length;
  }

  submit(sequence: number): void {
    this.#unresolved.push(sequence);
    this.#highestSubmitted = sequence;
    this.#submitted.add(sequence);
  }

  /** Check that `sequence` is the next operation to be acknowledged or failed before queueing. */
  verifyResolution(sequence: number): ProtocolResult<void> {
    if (sequence > this.#highestSubmitted)
      return reject('malformed-frame', 'future-acknowledgement');
    if (sequence === this.#lastResolved)
      return reject('malformed-frame', 'duplicate-acknowledgement');
    if (sequence < this.#lastResolved) return reject('malformed-frame', 'stale-acknowledgement');
    if (this.#unresolved[0] !== sequence) {
      return reject('malformed-frame', 'out-of-order-acknowledgement');
    }
    return accept(undefined);
  }

  /**
   * Check that a failure of an already accepted operation names an operation that was submitted.
   * Sequences are shared with other messages (such as `output-consumed`), so being no greater than
   * the highest submitted sequence is not enough: the sequence must itself have been an operation.
   */
  verifySubmitted(sequence: number): ProtocolResult<void> {
    if (sequence > this.#highestSubmitted)
      return reject('malformed-frame', 'future-acknowledgement');
    if (!this.#submitted.has(sequence)) return reject('malformed-frame', 'unknown-operation');
    return accept(undefined);
  }

  resolve(): void {
    this.#lastResolved = this.#unresolved.shift() ?? this.#lastResolved;
  }

  /**
   * Resolve the oldest unresolved operation because it was refused before it was queued. It never
   * entered the host FIFO, so it is no longer an operation a later `backend-failed` or
   * `transport-failed` may name.
   */
  refuse(): void {
    const sequence = this.#unresolved[0];
    this.resolve();
    if (sequence !== undefined) this.#submitted.delete(sequence);
  }
}

/**
 * Counts output bytes produced by the host against the cumulative count the client reports as
 * parsed. The count only moves forward and can never pass what was produced.
 */
export class OutputLedger {
  #produced: number;
  #consumed: number;

  constructor() {
    this.#produced = 0;
    this.#consumed = 0;
  }

  get produced(): number {
    return this.#produced;
  }

  get consumed(): number {
    return this.#consumed;
  }

  record(byteCount: number): void {
    this.#produced += byteCount;
  }

  /** Check a cumulative consumed-byte count against what was produced and already acknowledged. */
  verifyConsumed(total: number): ProtocolResult<void> {
    if (total > this.#produced) return reject('malformed-frame', 'over-counted-acknowledgement');
    if (total === this.#consumed) return reject('malformed-frame', 'duplicate-acknowledgement');
    if (total < this.#consumed) return reject('malformed-frame', 'stale-acknowledgement');
    return accept(undefined);
  }

  commitConsumed(total: number): void {
    this.#consumed = total;
  }
}
