/**
 * A queue that runs asynchronous writes one at a time, in the order they were requested. Each write
 * starts only after the one before it has settled, whether that one succeeded or failed, so two
 * writes that undo each other (add a tag, remove it) reach the engine in the order they were made and
 * the later one wins. Run independently, the second can land first and the first then durably undoes
 * it.
 */
export interface SerialQueue {
  /** How many writes have been queued and not yet settled, the one running included. */
  readonly pending: number;
  /** Queues `task`; the result is its own, and a rejection does not stop the writes behind it. */
  run<Result>(task: () => Promise<Result>): Promise<Result>;
}

/** Creates an empty queue that runs the writes handed to it one at a time, in order. */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    run<Result>(task: () => Promise<Result>): Promise<Result> {
      pending += 1;
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pending -= 1;
      });
    },
  };
}
