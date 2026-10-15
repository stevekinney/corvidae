/** The paths a sync can overwrite or delete: its emitted files and the prefixes it prunes or retires. */
export interface TransformReach {
  files: ReadonlySet<string>;
  prefixes: readonly string[];
}

/** Whether a sync would write or delete this target-relative path. */
export function transformReaches(reach: TransformReach, path: string): boolean {
  return (
    reach.files.has(path) ||
    reach.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}
