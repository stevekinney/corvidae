import type { CleanupOutcome, OutputChannel } from '../protocol/messages.ts';
import type { SessionClock } from './session-clock.ts';
import type { OutputSource, SourceOwnership } from './session-types.ts';
import { settleToOutcome } from './settle.ts';

/**
 * How much headroom a pull-based source waits for before it reads, so that a read is worth the
 * chunk it returns. A budget smaller than four times this waits for a quarter of itself instead.
 */
export const OUTPUT_LOW_WATER_BYTES = 64 * 1024;

/**
 * How much a pull-based source delivers before it gives the event loop a turn. Reads from a queue
 * resolve in microtasks, so without this a freed budget is delivered in one uninterrupted run: a
 * megabyte of frames built and sent while every other session, and the client of this one, wait.
 */
export const OUTPUT_YIELD_BYTES = 16 * 1024;

/** Where a started source delivers what it produces. */
export type SourceHandlers = {
  /**
   * Resolves with the bytes the output budget can take once it has at least `minimum` of them
   * (never more than the budget's own low-water share), or with `undefined` when the session no
   * longer accepts output: the attachment was revoked or the session closed. A pull-based source
   * reads only after this resolves, which is how a producer that is not read stays blocked.
   */
  room(minimum: number): Promise<number | undefined>;
  /**
   * Deliver as much of `bytes` as the output budget can take right now and say how much that was.
   * The room is checked and taken in the same step, so sources woken together by one release cannot
   * each take the whole of it; the rest stays with the source, which waits again.
   */
  offer(bytes: Uint8Array): number;
  chunk(bytes: Uint8Array): void;
  end(): void;
  failed(error: unknown): void;
};

/**
 * An output source with its ownership resolved. Opening acquires whatever the session must later
 * release (a stream's reader, an iterator) but reads nothing, so output a source has not yet been
 * asked for stays with the producer. `start` begins reading or subscribing; `release` is the
 * source's whole cleanup.
 */
export type OpenSource = {
  readonly channel: OutputChannel;
  readonly ownership: SourceOwnership;
  start(handlers: SourceHandlers): void;
  release(clock: SessionClock, deadlineMilliseconds: number): Promise<CleanupOutcome>;
};

/**
 * Copy before handing bytes on, so a producer that reuses or mutates its buffer afterwards cannot
 * change output the session has already accepted.
 */
function copy(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** What `pullInto` needs from a pull-based source. */
type Pullable = {
  /** The next chunk, or `undefined` once the source ended. */
  next(): Promise<Uint8Array | undefined>;
  ended(): void;
  failed(error: unknown): void;
  isReleased(): boolean;
};

/**
 * Drive a pull-based source from the session's output budget. The source is read only while the
 * budget has room, so a producer that nobody reads stays blocked in the kernel instead of being
 * buffered here; a chunk bigger than the room is cut to fit and the rest is carried, so the host
 * holds at most the budget plus one source chunk per source. Bytes read after the session stopped
 * accepting output are handed over once so they are counted as unavailable, never lost silently.
 */
async function pullInto(handlers: SourceHandlers, source: Pullable): Promise<void> {
  let sinceYield = 0;
  try {
    for (;;) {
      if ((await handlers.room(OUTPUT_LOW_WATER_BYTES)) === undefined || source.isReleased())
        return;
      const next = await source.next();
      if (next === undefined) {
        source.ended();
        return;
      }
      // Copied before anything else happens to it, so a producer that reuses its buffer cannot change accepted output.
      let carried = copy(next);
      do {
        const room = await handlers.room(Math.min(OUTPUT_LOW_WATER_BYTES, carried.length));
        if (room === undefined) {
          handlers.chunk(carried);
          return;
        }
        const take = handlers.offer(carried);
        carried = carried.subarray(take);
        sinceYield += take;
        if (sinceYield >= OUTPUT_YIELD_BYTES) {
          sinceYield = 0;
          // The neutral program has no timer globals, so the host's turn is looked up, as the system clock does.
          const turn = (globalThis as { setImmediate?: (callback: () => void) => unknown })
            .setImmediate;
          if (turn !== undefined) await new Promise<void>((resolve) => turn(resolve));
        }
      } while (carried.length > 0);
    }
  } catch (error) {
    source.failed(error);
  }
}

function openStream(channel: OutputChannel, source: Extract<OutputSource, { kind: 'stream' }>) {
  const reader = source.stream.getReader();
  let finished = false;
  let released = false;
  const pump = (handlers: SourceHandlers): Promise<void> =>
    pullInto(handlers, {
      next: async () => {
        const result = await reader.read();
        return result.done ? undefined : result.value;
      },
      ended: () => {
        finished = true;
        if (!released) handlers.end();
      },
      failed: (error) => {
        if (released) return;
        finished = true;
        handlers.failed(error);
      },
      isReleased: () => released,
    });
  const open: OpenSource = {
    channel,
    ownership: 'owned',
    start: (handlers) => {
      void pump(handlers);
    },
    release: (clock, deadlineMilliseconds) => {
      released = true;
      return settleToOutcome(clock, deadlineMilliseconds, async () => {
        if (!finished) {
          if (reader.cancel === undefined) throw new Error('stream reader cannot be canceled');
          await reader.cancel();
        }
        reader.releaseLock();
      });
    },
  };
  return open;
}

function openIterable(channel: OutputChannel, source: Extract<OutputSource, { kind: 'iterable' }>) {
  const iterator = source.iterable[Symbol.asyncIterator]();
  // Set only when the iterator reports `done`; a failed iteration is not finished and still needs `return()`.
  let finished = false;
  let released = false;
  const pump = (handlers: SourceHandlers): Promise<void> =>
    pullInto(handlers, {
      next: async () => {
        const result = await iterator.next();
        return result.done ? undefined : result.value;
      },
      ended: () => {
        finished = true;
        if (!released) handlers.end();
      },
      failed: (error) => {
        if (released) return;
        handlers.failed(error);
      },
      isReleased: () => released,
    });
  const open: OpenSource = {
    channel,
    ownership: 'owned',
    start: (handlers) => {
      void pump(handlers);
    },
    release: (clock, deadlineMilliseconds) => {
      released = true;
      return settleToOutcome(clock, deadlineMilliseconds, async () => {
        if (finished) return;
        if (iterator.return === undefined) throw new Error('iterator has no return()');
        await iterator.return();
      });
    },
  };
  return open;
}

function openSubscription(
  channel: OutputChannel,
  source: Extract<OutputSource, { kind: 'subscription' }>,
) {
  let unsubscribe: (() => void | Promise<void>) | undefined;
  let subscribeFailed = false;
  let released = false;
  const open: OpenSource = {
    channel,
    ownership: 'borrowed',
    start: (handlers) => {
      try {
        unsubscribe = source.subscribe(
          (bytes) => {
            if (!released) handlers.chunk(copy(bytes));
          },
          () => {
            if (!released) handlers.end();
          },
        );
      } catch (error) {
        // The producer may have registered the listener before it threw, and there is no handle to remove it with.
        subscribeFailed = true;
        throw error;
      }
    },
    release: (clock, deadlineMilliseconds) => {
      released = true;
      return settleToOutcome(clock, deadlineMilliseconds, () => {
        if (subscribeFailed)
          throw new Error('subscribe() failed without returning an unsubscribe handle');
        return unsubscribe?.();
      });
    },
  };
  return open;
}

/** Resolve a source definition into an open source. A locked stream or a bad iterable throws here. */
export function openSource(source: OutputSource): OpenSource {
  switch (source.kind) {
    case 'stream':
      return openStream(source.channel, source);
    case 'iterable':
      return openIterable(source.channel, source);
    case 'subscription':
      return openSubscription(source.channel, source);
  }
}
