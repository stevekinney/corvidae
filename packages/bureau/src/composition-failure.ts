/**
 * Stops the work a partially built composition already started, then rethrows
 * the error that stopped the composition (COR-716). A `shutdown` that itself
 * fails must not hide that error: the two are reported together as an
 * `AggregateError` whose message is the composition error's, so the caller
 * still learns what went wrong first.
 */
export async function shutdownThenRethrow(
  error: unknown,
  shutdown: () => Promise<unknown>,
): Promise<never> {
  try {
    await shutdown();
  } catch (shutdownError) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AggregateError(
      [error, shutdownError],
      `${message} (and shutting down after the failure also failed)`,
      { cause: shutdownError },
    );
  }
  throw error;
}
