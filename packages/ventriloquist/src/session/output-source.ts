import type { CleanupOutcome, OutputChannel } from '../protocol/messages.ts';
import type { SessionClock } from './session-clock.ts';
import type { OutputSource, SourceOwnership } from './session-types.ts';
import { settleToOutcome } from './settle.ts';

/** Where a started source delivers what it produces. */
export type SourceHandlers = {
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

function openStream(channel: OutputChannel, source: Extract<OutputSource, { kind: 'stream' }>) {
  const reader = source.stream.getReader();
  let finished = false;
  let released = false;
  const pump = async (handlers: SourceHandlers): Promise<void> => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          finished = true;
          if (!released) handlers.end();
          return;
        }
        // A chunk read while the release was in flight still belongs to the session, which accounts for it.
        handlers.chunk(copy(result.value));
      }
    } catch (error) {
      if (released) return;
      finished = true;
      handlers.failed(error);
    }
  };
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
  const pump = async (handlers: SourceHandlers): Promise<void> => {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done) {
          finished = true;
          if (!released) handlers.end();
          return;
        }
        handlers.chunk(copy(result.value));
      }
    } catch (error) {
      if (released) return;
      handlers.failed(error);
    }
  };
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
