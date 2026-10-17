/** The `code` of a Node filesystem error, such as `ENOENT`, or `undefined` for anything else. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
