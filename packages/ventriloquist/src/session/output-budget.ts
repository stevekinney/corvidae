type PendingChunk = { readonly byteLength: number; readonly endOffset: number };

/**
 * Accounts for output the session has accepted but the consumer has not finished parsing. Capacity
 * is held per chunk and returned only when the consumer reports that chunk's own parse
 * completion, either by its identifier or by a cumulative byte count that covers it. There is no
 * way to release capacity for a paint or for a global "everything parsed" signal, because neither
 * names a chunk.
 */
export class OutputBudget {
  readonly #limitBytes: number;
  readonly #pending = new Map<number, PendingChunk>();
  #pendingBytes = 0;
  #acceptedBytes = 0;
  #nextChunkId = 1;

  constructor(limitBytes: number) {
    this.#limitBytes = limitBytes;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get pendingChunks(): number {
    return this.#pending.size;
  }

  /** Reserve capacity for a chunk. Returns its identifier, or `undefined` when it does not fit. */
  reserve(byteLength: number): number | undefined {
    if (this.#pendingBytes + byteLength > this.#limitBytes) return undefined;
    const chunkId = this.#nextChunkId++;
    this.#acceptedBytes += byteLength;
    this.#pendingBytes += byteLength;
    this.#pending.set(chunkId, { byteLength, endOffset: this.#acceptedBytes });
    return chunkId;
  }

  /** Release one chunk whose parse completed. An unknown or already released chunk releases nothing. */
  release(chunkId: number): boolean {
    const chunk = this.#pending.get(chunkId);
    if (chunk === undefined) return false;
    this.#pending.delete(chunkId);
    this.#pendingBytes -= chunk.byteLength;
    return true;
  }

  /**
   * Release every pending chunk that ends at or before `consumedBytes`, the cumulative count of
   * accepted bytes the consumer has parsed. A chunk the count only partly covers stays pending.
   */
  releaseThrough(consumedBytes: number): number {
    let released = 0;
    for (const [chunkId, chunk] of this.#pending) {
      if (chunk.endOffset > consumedBytes) break;
      this.release(chunkId);
      released += 1;
    }
    return released;
  }
}
