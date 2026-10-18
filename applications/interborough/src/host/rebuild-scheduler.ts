/**
 * Rebuild scheduling for the development host. A save usually touches several files, and a build
 * takes long enough that another save can arrive while it runs, so rebuilds are debounced and
 * serialized: at most one build runs at a time, a change that lands during a build queues exactly
 * one more build once it finishes, and a build that failed because the tree was half-saved is
 * repaired by that queued build instead of being reported.
 *
 * @module rebuild-scheduler
 */

export type RebuildScheduler = {
  /** Rebuild soon: waits for the debounce, then builds, or queues behind a running build. */
  schedule(): void;
  /** Build now, or queue behind a running build, and settle when the newest build has. */
  run(): Promise<void>;
  /** Cancel a pending rebuild and refuse new ones. A running build is left to finish. */
  close(): void;
};

export type RebuildSchedulerOptions = {
  /** Compile the application. */
  readonly build: () => Promise<void>;
  /** Wait this long after the last change before building, so one save is one build. */
  readonly delayMilliseconds: number;
  /** Called after a scheduled rebuild succeeds. */
  readonly onRebuilt?: () => void;
  /** Called with the error of a scheduled rebuild that failed. */
  readonly onFailure?: (error: unknown) => void;
};

export function createRebuildScheduler(options: RebuildSchedulerOptions): RebuildScheduler {
  let closed = false;
  let running: Promise<void> | undefined;
  let buildAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // `close()` changes this from outside the build loop, which a bare read there would not show.
  const isClosed = (): boolean => closed;

  function run(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running !== undefined) {
      buildAgain = true;
      return running;
    }
    const current = (async () => {
      do {
        buildAgain = false;
        try {
          await options.build();
        } catch (error) {
          // A queued build will see the tree as it is now, so it repairs this failure.
          if (!buildAgain || isClosed()) throw error;
        }
      } while (buildAgain && !isClosed());
    })().finally(() => {
      running = undefined;
    });
    running = current;
    return current;
  }

  return {
    run,
    schedule() {
      if (closed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run().then(
          () => {
            if (!closed) options.onRebuilt?.();
            return undefined;
          },
          (error: unknown) => {
            if (!closed) options.onFailure?.(error);
            return undefined;
          },
        );
      }, options.delayMilliseconds);
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
