/** The `code` of a Node filesystem error, such as `ENOENT`, or `undefined` for anything else. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/**
 * The only parts of a failure that a public error keeps as its `cause`: the symbolic code, the
 * system call, and the numeric errno. A Node filesystem error also carries the path, and a path
 * inside `secrets/` ends in the secret's key, so the original error is never attached.
 */
export type SanitizedCause = {
  readonly code?: string;
  readonly syscall?: string;
  readonly errno?: number;
};

export function sanitizeCause(error: unknown): SanitizedCause {
  if (typeof error !== 'object' || error === null) return {};
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const syscall =
    'syscall' in error && typeof error.syscall === 'string' ? error.syscall : undefined;
  const errno = 'errno' in error && typeof error.errno === 'number' ? error.errno : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(syscall === undefined ? {} : { syscall }),
    ...(errno === undefined ? {} : { errno }),
  };
}
