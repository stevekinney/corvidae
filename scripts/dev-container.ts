/**
 * Make a Git worktree's repository reachable inside the Dev Container.
 *
 * The container mounts the opened checkout at its host path, so absolute paths agree on
 * both sides. A linked worktree's `.git` is a file naming its administrative directory,
 * `<common>/worktrees/<name>`, by absolute host path, and that common directory usually
 * sits outside the opened folder (`.claude/worktrees/*` live under the main checkout's
 * `.git`; Codex keeps its worktrees elsewhere entirely). The `initializeCommand` in
 * `.devcontainer/devcontainer.json` therefore points `.devcontainer/.git-common-dir` at
 * the host's common directory, the container mounts that link at
 * {@link CONTAINER_GIT_COMMON_DIRECTORY}, and this script, run as the `onCreateCommand`,
 * links the host path Git expects to that mount. A main checkout's `.git` is a
 * directory already inside the mount, so it needs nothing.
 *
 * Run inside the container from the workspace folder: `bun scripts/dev-container.ts`.
 */
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Where `devcontainer.json` mounts the host's Git common directory. */
export const CONTAINER_GIT_COMMON_DIRECTORY = '/corvidae-git';

/**
 * The common directory a linked worktree's `.git` file points into, or `null` when the
 * contents are not a worktree pointer in Git's standard `<common>/worktrees/<name>` layout.
 */
export function worktreeCommonDirectory(dotGitFile: string, workspace: string): string | null {
  const match = /^gitdir: (.+)$/mu.exec(dotGitFile);
  if (match === null) return null;
  const administrative = resolve(workspace, match[1]!.trim());
  if (basename(dirname(administrative)) !== 'worktrees') return null;
  return dirname(dirname(administrative));
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function linkWorktreeRepository(workspace: string): Promise<string> {
  const dotGit = join(workspace, '.git');
  const entry = await lstat(dotGit);
  if (entry.isDirectory()) return 'The checkout is a main checkout.';
  const common = worktreeCommonDirectory(await readFile(dotGit, 'utf8'), workspace);
  if (common === null) throw new Error(`${dotGit} does not name a standard Git worktree.`);
  if (await exists(common)) return `${common} is already reachable.`;
  // The parent sits beside the bind mount's own parents, which Docker created as root.
  const parent = dirname(common);
  const sudo = ['sudo', '--non-interactive'];
  await run([...sudo, 'mkdir', '-p', parent]);
  await run([...sudo, 'ln', '-s', CONTAINER_GIT_COMMON_DIRECTORY, common]);
  return `Linked ${common} to ${CONTAINER_GIT_COMMON_DIRECTORY}.`;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command.join(' ')} exited ${status}.`);
}

if (import.meta.main) {
  console.log(await linkWorktreeRepository(process.cwd()));
}
