/**
 * The directories whose children are corvidae's workspaces, in the order the root `package.json`
 * lists them. `scripts/browser-fixtures` is the one workspace outside them, and it is listed by
 * its own path there.
 *
 * Every repository script that discovers or scans workspaces reads this list instead of spelling
 * its own, so a new workspace directory cannot fall outside one scan while the others see it.
 * `workspace-contract.test.ts` keeps it equal to the root `workspaces` field.
 */
export const workspaceParentDirectories = [
  'applications',
  'components',
  'packages',
  'testing',
  'internal',
] as const;

/**
 * The directories that hold only verification tooling. A workspace under one of them may appear in
 * another workspace's `devDependencies` but never in its `dependencies`, so nothing that ships can
 * depend on it. `workspace-contract.test.ts` enforces that.
 */
export const verificationWorkspaceDirectories = ['testing'] as const;

/** A `Bun.Glob` brace group over the given directories, such as `{applications,packages}`. */
export function directoryGlob(directories: readonly string[]): string {
  return `{${directories.join(',')}}`;
}
