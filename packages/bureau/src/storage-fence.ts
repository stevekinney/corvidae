/**
 * COR-1767 — Bureau's view of the storage it was given.
 *
 * Bureau never disposes a storage it was given: the caller constructed it and closes it after the
 * Bureau has shut down. Bureau must still stop using it at shutdown, and when its construction
 * fails, because work left over from a Bureau that is going away (a waiter settled after the engine
 * stopped, a session record settled after a failed boot) would otherwise write to a store that a
 * later Bureau or another process owns. Closing the fence is that stop: every storage operation
 * through the fenced view throws once it is closed, as an operation on a closed handle does, and
 * the caller's own handle stays open.
 *
 * @module storage-fence
 */

import type { Storage } from '@lostgradient/storage';

/** A fenced view of a caller's storage, and the switch that stops Bureau's use of it. */
export interface StorageFence {
  /** Forwards to the caller's storage until {@link close}, then refuses every operation. */
  readonly storage: Storage;
  /** Stops every later operation through {@link storage}. Never closes the caller's storage. */
  close(): void;
}

interface FenceState {
  closed: boolean;
}

/** The error an operation through a closed fence throws. */
function fenceClosed(operation: string): Error {
  return new Error(
    `Bureau has stopped using its storage (it shut down or failed to start), so "${operation}" was refused.`,
  );
}

function fencedView(inner: Storage, state: FenceState): Storage {
  return new Proxy(inner, {
    get(target, property) {
      // Read with the adapter itself as the receiver, so its own accessors reach its private state.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...parameters: unknown[]) => unknown;
      if (property === 'capabilities') return method.bind(target);
      if (property === Symbol.dispose || property === Symbol.asyncDispose) {
        // Disposing Bureau's view stops Bureau's use of the store; the caller's handle stays open.
        return () => {
          state.closed = true;
        };
      }
      if (property === 'scoped') {
        return (...parameters: unknown[]) => {
          if (state.closed) throw fenceClosed('scoped');
          return fencedView(method.apply(target, parameters) as Storage, state);
        };
      }
      return (...parameters: unknown[]) => {
        if (state.closed) throw fenceClosed(String(property));
        return method.apply(target, parameters);
      };
    },
  });
}

/**
 * Wraps `storage` in a fence. Optional capabilities stay optional: the view has a method exactly
 * when the caller's storage does, so capability detection by method presence is unchanged.
 */
export function fenceStorage(storage: Storage): StorageFence {
  const state: FenceState = { closed: false };
  return {
    storage: fencedView(storage, state),
    close() {
      state.closed = true;
    },
  };
}
