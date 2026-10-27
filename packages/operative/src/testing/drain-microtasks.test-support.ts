import { flushPortableMicrotasks } from '@lostgradient/weft';

/**
 * How many promise turns one drain awaits. A drain is a count of microtask hops, a property of the
 * code under test's promise chains and never of host load: microtasks run to completion before the
 * event loop takes any other task, so a chain that needs more hops than this fails the same way on
 * every host.
 */
const MICROTASK_TURNS = 100;

/**
 * Let every promise continuation that is already queued, and every one those continuations queue,
 * run. Use it where the next step depends only on microtask work: an in-memory store, a scripted
 * model, a manual clock. It never yields to a timer or an I/O callback, so it cannot be too short
 * on a loaded host. A step that needs a socket, a timer, a child process or another engine's
 * macrotask must wait on that state instead (`waitUntil`, or a promise the code under test
 * resolves).
 */
export function drainMicrotasks(): Promise<void> {
  return flushPortableMicrotasks(MICROTASK_TURNS);
}
