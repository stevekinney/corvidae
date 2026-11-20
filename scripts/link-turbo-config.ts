// Gives a Git worktree the main checkout's Turborepo link, so it uses the remote cache too.
//
//   bun scripts/link-turbo-config.ts            the current checkout
//   bun scripts/link-turbo-config.ts --all      every worktree of this repository
//
// `turbo link` writes the team to `.turbo/config.json` in the checkout it ran in, an ignored file.
// Turborepo shares the main checkout's local cache with its worktrees but not that link, so a
// worktree runs with remote caching off. This copies the file into a worktree that has none; it
// never overwrites one. The Claude Code SessionStart hook runs it, and it fails open: a missing
// link or a checkout outside Git changes nothing.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { rootScriptEnvironment } from './environment-configuration.ts';

const CONFIG = join('.turbo', 'config.json');

function git(directory: string, ...argumentsList: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...argumentsList], { cwd: directory, stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** The main checkout of the repository `directory` is in, or undefined outside Git. */
export function mainCheckout(directory: string): string | undefined {
  const common = git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return common === undefined ? undefined : dirname(resolve(common));
}

/** Copies the main checkout's link into `worktree` when it has none. Returns whether it copied. */
export function linkWorktree(main: string, worktree: string): boolean {
  const source = join(main, CONFIG);
  const target = join(worktree, CONFIG);
  if (resolve(main) === resolve(worktree) || !existsSync(source) || existsSync(target))
    return false;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

function worktrees(main: string): string[] {
  const list = git(main, 'worktree', 'list', '--porcelain') ?? '';
  return list
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

if (import.meta.main) {
  try {
    const here = rootScriptEnvironment()['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const main = mainCheckout(here);
    if (main !== undefined) {
      const targets = process.argv.includes('--all') ? worktrees(main) : [here];
      const linked = targets.filter(
        (worktree) => existsSync(worktree) && linkWorktree(main, worktree),
      );
      if (process.argv.includes('--all')) console.log(`linked ${linked.length} worktree(s)`);
    }
  } catch {
    // Fail open: a session must start whatever happens here.
  }
}
