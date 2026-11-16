/**
 * What a reaction's `run` throws to say that retrying cannot change the answer: the channel it was
 * asked to post to does not exist, or the input it was given is one the service refuses for good.
 * A reaction that rejects with anything else, or with this error and no `permanent: true`, fails
 * that attempt and is tried again until its delivery runs out of attempts.
 *
 * Bureau recognises the error by its `name` and its `permanent` property, never with `instanceof`,
 * so a plugin loaded from a folder, which carries its own copy of this package, is understood too.
 */
export class PluginReactionError extends Error {
  /**
   * `true` when a retry cannot change the answer, so the delivery ends `failed` after this attempt
   * instead of being retried.
   */
  readonly permanent: boolean;

  /**
   * @param message What went wrong. It is kept on the attempt, cut to a few hundred characters, and
   * shown to the person who owns the hook, so it must carry no secret.
   * @param options `permanent` marks a failure a retry cannot change (default `false`); `cause` is the
   * error that led to this one.
   */
  constructor(
    message: string,
    options: { readonly permanent?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PluginReactionError';
    this.permanent = options.permanent ?? false;
  }
}
