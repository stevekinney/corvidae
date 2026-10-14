import { MAXIMUM_QUEUED_OPERATIONS } from './protocol-constants.ts';
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
  /**
   * The operations a submitted-operation failure may still name: every unresolved one, and the
   * acknowledged ones still inside the host FIFO window. Sequences of other messages are never in it.
   *
   * The window is the negotiated FIFO depth plus the one operation the host is processing. The
   * contract bounds the host FIFO ("the bounded host FIFO is 256 operations"), keeps input and
   * resize in one order ("Input and resize share one ordered operation sequence and FIFO"), and
   * says an acknowledgement is acceptance "into that bounded host FIFO, never backend consumption",
   * while "a submitted operation can still fail later" and `backend-failed` is a "submitted
   * operation" failure. An operation can fail while it is in the FIFO or while the host processes
   * it. Processing follows FIFO order and takes the oldest operation out of the FIFO, so the
   * active operation is no longer among the `window` queued ones yet must stay failable. It has
   * finished only once `window + 1` newer operations have been accepted behind it: `window` still
   * queued, and the one the host took after it. The ledger therefore holds at most `window + 1`
   * acknowledged operations plus the unresolved ones (at most `window`), however long the
   * attachment lives.
   */
  readonly #submitted: Set<number>;
  /** The acknowledged operations still inside the window, oldest first: the queued ones and the active one. */
  readonly #acknowledged: number[];
  readonly #window: number;

  constructor(window = MAXIMUM_QUEUED_OPERATIONS) {
    this.#window = window;
    this.#acknowledged = [];
    this.#unresolved = [];
    this.#lastResolved = 0;
    this.#highestSubmitted = 0;
    this.#submitted = new Set();
  }

  get unresolvedCount(): number {
    return this.#unresolved.length;
  }

  /** How many operations a submitted-operation failure can still name: bounded by twice the window plus the active operation. */
  get trackedCount(): number {
    return this.#submitted.size;
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

  /** Resolve the oldest unresolved operation because the host accepted it into its FIFO. */
  resolve(): void {
    const sequence = this.#unresolved[0];
    this.#shift();
    if (sequence === undefined) return;
    this.#acknowledged.push(sequence);
    if (this.#acknowledged.length > this.#window + 1) {
      this.#submitted.delete(this.#acknowledged.shift()!);
    }
  }

  #shift(): void {
    this.#lastResolved = this.#unresolved.shift() ?? this.#lastResolved;
  }

  /**
   * Retire an operation that has received its terminal failure, from every ledger and queue. A
   * second terminal failure naming it is then `unknown-operation`, and an acknowledgement naming
   * it is refused: one operation never reports two terminal results, or a result after its failure.
   */
  retire(sequence: number): void {
    this.#submitted.delete(sequence);
    const position = this.#unresolved.indexOf(sequence);
    if (position === 0) this.#shift();
    else if (position > 0) this.#unresolved.splice(position, 1);
    const acknowledged = this.#acknowledged.indexOf(sequence);
    if (acknowledged >= 0) this.#acknowledged.splice(acknowledged, 1);
  }

  /**
   * Resolve the oldest unresolved operation because it was refused before it was queued. It never
   * entered the host FIFO, so it is no longer an operation a later `backend-failed` or
   * `transport-failed` may name.
   */
  refuse(): void {
    const sequence = this.#unresolved[0];
    this.#shift();
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
