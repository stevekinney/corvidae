/**
 * A linked git worktree runs its own Interborough (COR-2540). Two agents working in two worktrees
 * can each run `bun run dev` and drive their own host with the CLI, with no variable to set and no
 * effect on the owner's real data: the development supervisor gives a linked worktree a home under
 * its own `tmp/` and a free port, and the CLI run from that worktree finds the host through the
 * record the host leaves in that home (`instance-record.ts`).
 *
 * A linked worktree is git's own idea: a checkout where `git rev-parse --git-dir` and `--git-common-dir`
 * name different directories. In the main checkout they name the same one, so nothing is derived
 * there and the home stays `~/.interborough` on port 7234. An `INTERBOROUGH_HOME` or
 * `INTERBOROUGH_PORT` that is set wins over the derived value in every checkout, each on its own.
 *
 * The derivation is a pure function over facts passed in, which keeps it out of the host: the host
 * (`startHost`, `resolvePort`, Bungalow) knows nothing of worktrees, so an installed `interborough
 * start` run inside someone's worktree is unchanged. Only the development supervisor applies it.
 *
 * @module worktree-instance
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { BungalowEnvironment } from '@lostgradient/bungalow';

import { PORT_VARIABLE } from './environment-configuration.ts';

/** The variable that names the home, which the derived home yields to (read by Bungalow). */
export const HOME_VARIABLE = 'INTERBOROUGH_HOME';

/** Where a linked worktree's home is, relative to the worktree: `tmp/` is ignored by git. */
export const WORKTREE_HOME_SEGMENTS = ['tmp', 'interborough-dev'] as const;

/** The home a linked worktree at `root` uses unless `INTERBOROUGH_HOME` names another. */
export function worktreeHome(root: string): string {
  return join(root, ...WORKTREE_HOME_SEGMENTS);
}

/** What `git rev-parse` printed for a directory, or `undefined` when git could not say (not a repository, or no git). */
export type GitDirectories = {
  /** `--git-dir`: this checkout's own git directory. */
  readonly gitDirectory: string;
  /** `--git-common-dir`: the git directory the checkouts of one repository share. */
  readonly commonDirectory: string;
  /** `--show-toplevel`: the checkout's root. */
  readonly topLevel: string;
};

/** Ask git about `directory`, with every path absolute. Resolves `undefined` where git has no answer. */
export type GitReader = (directory: string) => GitDirectories | undefined;

/** The git the machine has, asked once for the three paths: a failure of any kind is "not a repository". */
export const readGitDirectories: GitReader = (directory) => {
  try {
    const result = Bun.spawnSync(
      [
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ],
      { cwd: directory, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
    );
    if (result.exitCode !== 0) return undefined;
    const [gitDirectory, commonDirectory, topLevel] = result.stdout
      .toString()
      .trimEnd()
      .split('\n');
    if (!gitDirectory || !commonDirectory || !topLevel) return undefined;
    return { gitDirectory, commonDirectory, topLevel };
  } catch {
    // No git on the machine, or `directory` is not there: nothing to derive.
    return undefined;
  }
};

/** A path with symbolic links resolved (macOS keeps its temporary directory behind one), else as given. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The root of the linked worktree `directory` is in, or `undefined` for the main checkout, for a
 * directory that is in no repository, and for a machine without git. `read` is the git lookup, which
 * a test replaces.
 */
export function linkedWorktreeRoot(
  directory: string,
  read: GitReader = readGitDirectories,
): string | undefined {
  const found = read(directory);
  if (found === undefined) return undefined;
  return real(found.gitDirectory) === real(found.commonDirectory)
    ? undefined
    : real(found.topLevel);
}

/** What the derivation chose: only the values it filled in, each absent where the person's own won. */
export type DerivedInstance = {
  /** The worktree's root. */
  readonly root: string;
  /** The home it chose, when `INTERBOROUGH_HOME` was not set. */
  readonly home?: string;
  /** The port it chose, when `INTERBOROUGH_PORT` was not set. */
  readonly port?: number;
};

/**
 * `environment` with a home under the linked worktree at `root` and a port from `freePort`, each
 * filled in only where its variable is unset or empty. With no `root` (the main checkout, or
 * outside a repository), or with both variables set, the environment comes back unchanged and
 * nothing is derived. With `home: false` no home is derived: the showcase host has a home of its
 * own, per worktree already (`showcase.ts`), that replaces whatever `INTERBOROUGH_HOME` says.
 */
export async function deriveInstanceEnvironment(
  environment: BungalowEnvironment,
  root: string | undefined,
  freePort: () => number | Promise<number>,
  options: { readonly home?: boolean } = {},
): Promise<{
  readonly environment: BungalowEnvironment;
  readonly derived: DerivedInstance | undefined;
}> {
  if (root === undefined) return { environment, derived: undefined };
  const needsHome =
    options.home !== false &&
    (environment[HOME_VARIABLE] === undefined || environment[HOME_VARIABLE] === '');
  const needsPort = environment[PORT_VARIABLE] === undefined || environment[PORT_VARIABLE] === '';
  if (!needsHome && !needsPort) return { environment, derived: undefined };
  const home = needsHome ? worktreeHome(root) : undefined;
  const port = needsPort ? await freePort() : undefined;
  return {
    environment: {
      ...environment,
      ...(home === undefined ? {} : { [HOME_VARIABLE]: home }),
      ...(port === undefined ? {} : { [PORT_VARIABLE]: String(port) }),
    },
    derived: {
      root,
      ...(home === undefined ? {} : { home }),
      ...(port === undefined ? {} : { port }),
    },
  };
}

/** The sentence the development supervisor prints when it derived something, naming each derived value. */
export function derivedInstanceMessage(derived: DerivedInstance): string {
  const parts = [
    ...(derived.home === undefined ? [] : [`its state lives in ${derived.home}`]),
    ...(derived.port === undefined ? [] : [`it listens on port ${derived.port}`]),
  ];
  return `${derived.root} is a linked git worktree, so it runs its own Interborough: ${parts.join(' and ')}. Set ${HOME_VARIABLE} or ${PORT_VARIABLE} to choose another.`;
}

/** A port the operating system says is free right now, found by listening on port 0 and letting go. */
export async function operatingSystemFreePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('The operating system gave no free port.');
  return port;
}

/**
 * The home a CLI run in `directory` would find a worktree's host in: `INTERBOROUGH_HOME` when it is
 * set to an absolute path, else the derived home. `undefined` outside a linked worktree.
 */
export function worktreeHomeFor(
  directory: string,
  environment: BungalowEnvironment,
  read: GitReader = readGitDirectories,
): string | undefined {
  const root = linkedWorktreeRoot(directory, read);
  if (root === undefined) return undefined;
  const named = environment[HOME_VARIABLE];
  if (named === undefined || named === '') return worktreeHome(root);
  return isAbsolute(named) ? resolve(named) : undefined;
}
