type Entry = {
  readonly length: number;
  remaining: number;
};

/**
 * Orders the acknowledgements of output. Each delivered chunk is registered with the number of
 * subscribers that must report it parsed, and the cumulative count is released only for the leading
 * chunks that are all parsed, so the host never hears about a byte before every byte ahead of it.
 * Receiving a chunk, or a socket buffer draining, never calls into here: only a parse report does.
 */
export class OutputReleaseQueue {
  readonly #entries: Entry[] = [];
  readonly #acknowledge: (bytes: number) => void;

  constructor(acknowledge: (bytes: number) => void) {
    this.#acknowledge = acknowledge;
  }

  /** How many chunks are waiting for a parse report. */
  get unreleasedChunks(): number {
    return this.#entries.length;
  }

  /**
   * Register a chunk of `length` bytes that `parsers` subscribers must each report. The returned
   * function reports one of them; calling it more times than there are parsers does nothing.
   */
  register(length: number, parsers: number): () => void {
    const entry: Entry = { length, remaining: parsers };
    this.#entries.push(entry);
    return () => {
      if (entry.remaining === 0) return;
      entry.remaining -= 1;
      if (entry.remaining === 0) this.#release();
    };
  }

  #release(): void {
    let bytes = 0;
    for (let entry = this.#entries[0]; entry?.remaining === 0; entry = this.#entries[0]) {
      bytes += entry.length;
      this.#entries.shift();
    }
    if (bytes > 0) this.#acknowledge(bytes);
  }
}
