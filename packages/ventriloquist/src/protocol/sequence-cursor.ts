import { MAXIMUM_SEQUENCE } from './protocol-constants.ts';
import { accept, reject, type ProtocolResult } from './protocol-failure.ts';

/**
 * The sequence position of one direction of one attachment. Sequences start at 1 and each frame
 * must carry exactly the next number, so a duplicate, a replay of an older frame and a gap are all
 * visible. `last` is the number of the most recent frame accepted or issued.
 */
export class SequenceCursor {
  #last: number;

  constructor(last = 0) {
    this.#last = last;
  }

  get last(): number {
    return this.#last;
  }

  /** Check an incoming sequence without consuming it. Overflow is reported before anything else. */
  verify(sequence: number): ProtocolResult<void> {
    if (this.#last >= MAXIMUM_SEQUENCE) return reject('malformed-frame', 'sequence-overflow');
    if (sequence === this.#last) return reject('malformed-frame', 'duplicate-sequence');
    if (sequence !== this.#last + 1) return reject('malformed-frame', 'out-of-order-sequence');
    return accept(undefined);
  }

  /** The sequence the next outgoing frame must carry, without consuming it. */
  peekNext(): ProtocolResult<number> {
    if (this.#last >= MAXIMUM_SEQUENCE) return reject('transport-failed', 'sequence-overflow');
    return accept(this.#last + 1);
  }

  commit(sequence: number): void {
    this.#last = sequence;
  }
}
