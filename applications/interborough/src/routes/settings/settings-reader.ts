/**
 * Reads the settings again when the Bureau says they changed (COR-1751), and guarantees that a
 * notification is never lost to a read that was already running.
 *
 * A read that is in flight when a notification arrives may have captured the settings before the
 * change. TanStack Query hands a refetch of a query that holds no data the fetch already in flight,
 * so on a cold load the notification would be consumed by a read that reports the old revision. The
 * reader therefore does not take a read's settling as the end of a notification: it compares the
 * revision the read reported with the revision the notification named, and reads once more when the
 * read is not known to be at least that new.
 *
 * - A notification that names a revision is met by any read that reports that revision or a newer
 *   one, and by any read that began after it arrived.
 * - A notification that names none (the Bureau accepted a subscription) is met only by a read that
 *   began after it arrived, since a read in flight may have come before the subscription.
 * - A read that fails ends the wait: the page keeps what it holds and reads again on focus.
 */

/** What one read reports. */
export type SettingsReadOutcome = {
  /** The revision of the settings the read returned. */
  readonly revision: number;
  /** Whether the read began after the notification, rather than joining one already in flight. */
  readonly fresh: boolean;
};

export type SettingsReaderOptions = {
  /** Reads the settings, or joins the read in flight. Resolves `undefined` when the read failed. */
  readonly read: () => Promise<SettingsReadOutcome | undefined>;
};

export class SettingsReader {
  readonly #read: SettingsReaderOptions['read'];
  /** Notifications no settled read has met yet: the revision each named, or `undefined`. */
  #pending: Array<number | undefined> = [];
  #running: Promise<void> | undefined;

  constructor(options: SettingsReaderOptions) {
    this.#read = options.read;
  }

  /**
   * Notes that the settings changed (to `revision`, when the notification names one) and reads
   * them. The promise settles when no notification is left unmet.
   */
  notify(revision?: number): Promise<void> {
    this.#pending.push(revision);
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const considered = this.#pending;
      this.#pending = [];
      const outcome = await this.#read();
      if (outcome === undefined) {
        this.#pending = [];
        return;
      }
      const stillBehind = (revision: number | undefined): boolean =>
        revision === undefined || revision > outcome.revision;
      // Those considered when the read began are met by a fresh read, or by one at their revision.
      const unmetBefore = outcome.fresh
        ? []
        : considered.filter((revision) => stillBehind(revision));
      // Those that arrived while it ran began after it did, so only its revision can meet them.
      const unmetDuring = this.#pending.filter((revision) => stillBehind(revision));
      this.#pending = [...unmetBefore, ...unmetDuring];
    }
  }
}
