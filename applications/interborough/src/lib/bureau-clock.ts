/**
 * The Bureau's clock as the page reads it (COR-2014).
 *
 * Every time a chat shows is the Bureau's: a message's, a reply's, a tool call's. A host can run
 * on a clock of its own (the showcase runs on an offset one), so the page's clock is not the
 * Bureau's, and a time the page reads off its own clock, such as when a message it could not send
 * was tried, or how long a call has been running, would be wrong by the difference. The Bureau
 * stamps every AG-UI event it sends with its own time (`timestamp`, epoch milliseconds), so each
 * event the page reads says how far apart the two clocks are, and this keeps the latest reading.
 * Until an event has said, the two are taken to agree.
 */
export class BureauClock {
  #offset = 0;

  constructor(private readonly pageNow: () => number = () => Date.now()) {}

  /**
   * Takes the Bureau's time from an event it stamped: `timestamp`, when it is a finite number. An
   * event without one says nothing, and the reading before it stands.
   */
  observe(event: unknown): void {
    if (typeof event !== 'object' || event === null) return;
    const timestamp = (event as { readonly timestamp?: unknown }).timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      this.#offset = timestamp - this.pageNow();
    }
  }

  /** The Bureau's time now, in epoch milliseconds. */
  now(): number {
    return this.pageNow() + this.#offset;
  }

  /** The Bureau's time now, as an ISO 8601 string, as a row's `createdAt` is written. */
  nowISO(): string {
    return new Date(this.now()).toISOString();
  }
}
