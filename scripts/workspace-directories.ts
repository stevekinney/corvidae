import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  'plugins',
] as const;

/**
 * The directories that hold only verification tooling. A library or component may name a workspace
 * under one of them in `devDependencies` but never in `dependencies` or `peerDependencies`, so no
 * shared code carries it at runtime. Applications are exempt: they are endpoints nothing depends
 * on. `workspace-contract.test.ts` enforces that.
 */
export const verificationWorkspaceDirectories = ['testing'] as const;

/** A `Bun.Glob` brace group over the given directories, such as `{applications,packages}`. */
export function directoryGlob(directories: readonly string[]): string {
  return `{${directories.join(',')}}`;
}

/**
 * The names of the directories directly inside `parent` below `root`, or none when `parent` does
 * not exist. A parent directory such as `plugins` is listed in the root `workspaces` before any
 * workspace lives in it, so a scan must tolerate its absence instead of failing with `ENOENT`.
 */
export function workspaceChildDirectoryNames(root: string, parent: string): string[] {
  const directory = join(root, parent);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * The directories a source scan reads below `root`: every workspace parent directory that exists,
 * then `scripts`. A parent such as `plugins` can be listed before it holds a workspace, and a scan
 * that walks a missing directory fails with `ENOENT`.
 */
export function scannedSourceDirectories(root: string): string[] {
  return [...workspaceParentDirectories, 'scripts'].filter((directory) =>
    existsSync(join(root, directory)),
  );
}
