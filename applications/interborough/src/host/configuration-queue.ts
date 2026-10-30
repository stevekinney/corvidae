/**
 * The queue every writer of `configuration.json` shares. A write reads the file, changes the part
 * it owns, and writes the whole file back, so two writers that overlap would each start from the
 * text the other is about to replace, and the later write would drop the earlier one's change.
 * Running each read-change-write through one queue keeps them apart. The provider manager
 * (`provider-manager.ts`) is one writer; another part of the host that writes the file (for
 * example a feature that keeps its own settings in it) takes the queue from
 * `Host.configurationQueue` and runs its whole read-change-write inside {@link ConfigurationQueue.run}.
 * The queue orders writers inside this process; Bungalow's lock keeps a second process out.
 *
 * @module configuration-queue
 */

/** Runs read-change-write cycles on `configuration.json` one at a time, in the order they were asked for. */
export type ConfigurationQueue = {
  /**
   * Run `work` after every earlier piece of work has settled, and settle with its result. A piece
   * of work that fails does not stop the ones behind it.
   */
  run<Result>(work: () => Promise<Result>): Promise<Result>;
};

/** Create a queue. The host creates one and shares it; a test may create its own. */
export function createConfigurationQueue(): ConfigurationQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(work) {
      const result = tail.then(work);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
