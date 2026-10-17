/** The base of every error Bungalow throws, so a caller can catch the whole family at once. */
export class BungalowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A name, key, or environment value the caller supplied is unusable. The message never echoes a
 * secret key or value.
 */
export class BungalowInputError extends BungalowError {}

/** Another open handle, in this process or another, holds the root's lock. */
export class BungalowLockedError extends BungalowError {
  /**
   * The process identifier on the first line of the lock file, or `undefined` in the instant
   * between a holder taking the lock and recording itself. Advisory: the lock is the kernel's,
   * and the file only says who asked for it last.
   */
  readonly holderProcessIdentifier: number | undefined;

  constructor(root: string, holderProcessIdentifier: number | undefined) {
    super(
      holderProcessIdentifier === undefined
        ? `The Bungalow at ${root} is already open in another process.`
        : `The Bungalow at ${root} is already open in process ${holderProcessIdentifier}.`,
    );
    this.holderProcessIdentifier = holderProcessIdentifier;
  }
}

/**
 * A filesystem operation failed. The message names the operation, never an entry or a value. The
 * `cause` is a sanitized object holding only the code, system call, and errno of the failure.
 */
export class BungalowFilesystemError extends BungalowError {}

/** The handle was used after `close()`, or a persisted file holds something Bungalow cannot read. */
export class BungalowStateError extends BungalowError {}

/** The host cannot provide the whole-file lock Bungalow needs: macOS and Linux only. */
export class BungalowUnsupportedError extends BungalowError {}
