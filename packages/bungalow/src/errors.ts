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
  /** The process identifier recorded in the lock file. */
  readonly holderProcessIdentifier: number;

  constructor(root: string, holderProcessIdentifier: number) {
    super(
      `The Bungalow at ${root} is already open in process ${holderProcessIdentifier}. ` +
        'Close that process, or remove the lock file if it is stale.',
    );
    this.holderProcessIdentifier = holderProcessIdentifier;
  }
}

/**
 * A filesystem operation failed. The message names the operation and the entry, never a value that
 * was being written; the underlying error is the `cause`.
 */
export class BungalowFilesystemError extends BungalowError {}

/** The handle was used after `close()`, or a persisted file holds something Bungalow cannot read. */
export class BungalowStateError extends BungalowError {}
