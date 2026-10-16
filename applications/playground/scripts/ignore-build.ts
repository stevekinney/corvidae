/**
 * Decides whether Vercel builds cinder.website. Run by `ignore-build.sh`, Vercel's Ignored Build
 * Step, before anything is installed, so it imports nothing outside Bun, Node built-ins, and its
 * own dependency-free environment boundary.
 *
 * A build renders every component page and takes the better part of an hour, so it runs only
 * when the deployed site could differ:
 *
 * - A preview deployment never builds unless the subject line of its commit message carries
 *   {@link PREVIEW_OPT_IN}. `bun run validate` already runs the same static export.
 * - A production deployment builds when a commit since the last successful one touches a file
 *   the export can read: a non-test file in a workspace of the playground's dependency closure,
 *   or a root input to `bun install` or TypeScript. The published versions the documentation
 *   displays live in `src/published-versions.json`, a file of this workspace, so changing one
 *   rebuilds like any other source change.
 *
 * Whenever it cannot tell, it builds. Exit 1 means build and exit 0 means skip.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ignoreStepEnvironment } from './environment-configuration.ts';

export const PREVIEW_OPT_IN = '[playground preview]';
export const PLAYGROUND_PACKAGE = '@lostgradient/playground';

/** Root files that change what `bun install` resolves or how TypeScript reads the sources. */
const ROOT_INPUT = /^(package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json)$/;

/**
 * Files only a test runner reads. The static export imports none of them, so a change confined to
 * them cannot change the site. Anything else in a closure workspace, a test helper included, still
 * counts.
 */
const TEST_ONLY =
  /(\.(test|spec|bench)\.(ts|svelte)$|^applications\/playground\/(tests\/|playwright\.config\.ts$))/;

type Manifest = Record<string, unknown>;

export type Workspace = { name: string; directory: string; manifest: Manifest };

export type Decision = { build: boolean; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** Every workspace the root manifest declares, expanding `directory/*` patterns one level. */
export function readWorkspaces(repositoryRoot: string): Workspace[] {
  const patterns = readManifest(join(repositoryRoot, 'package.json'))['workspaces'];
  if (!Array.isArray(patterns)) throw new Error('the root package.json declares no workspaces');
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') throw new Error(`unsupported workspace pattern ${pattern}`);
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      if (!existsSync(join(repositoryRoot, parent))) continue;
      for (const entry of readdirSync(join(repositoryRoot, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
      }
    } else if (pattern.includes('*')) {
      throw new Error(`unsupported workspace pattern ${pattern}`);
    } else {
      directories.push(pattern);
    }
  }
  return directories
    .filter((directory) => existsSync(join(repositoryRoot, directory, 'package.json')))
    .map((directory) => {
      const manifest = readManifest(join(repositoryRoot, directory, 'package.json'));
      const name = manifest['name'];
      if (typeof name !== 'string') throw new Error(`${directory}/package.json has no name`);
      return { name, directory, manifest };
    });
}

function workspaceDependencies(manifest: Manifest, fields: readonly string[]): string[] {
  return fields.flatMap((field) => {
    const dependencies = manifest[field];
    return isRecord(dependencies) ? Object.keys(dependencies) : [];
  });
}

/**
 * The workspaces the playground's build can read: the playground, its development dependencies
 * (the shared TypeScript configuration), and every workspace any of those depends on at runtime.
 */
export function dependencyClosure(workspaces: readonly Workspace[], start: string): Workspace[] {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const root = byName.get(start);
  if (root === undefined) throw new Error(`no workspace is named ${start}`);
  const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
  const reached = new Map<string, Workspace>();
  const pending = [
    root,
    ...workspaceDependencies(root.manifest, ['devDependencies']).flatMap(
      (name) => byName.get(name) ?? [],
    ),
  ];
  for (let workspace = pending.pop(); workspace !== undefined; workspace = pending.pop()) {
    if (reached.has(workspace.name)) continue;
    reached.set(workspace.name, workspace);
    for (const name of workspaceDependencies(workspace.manifest, runtimeFields)) {
      const dependency = byName.get(name);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  return [...reached.values()].toSorted((left, right) =>
    left.directory.localeCompare(right.directory),
  );
}

export type ChangeInputs = {
  changedFiles: readonly string[];
  closure: readonly Workspace[];
};

/** Whether the files changed since the last successful deployment can change the site. */
export function decideFromChanges({ changedFiles, closure }: ChangeInputs): Decision {
  const relevant = changedFiles.filter(
    (file) =>
      ROOT_INPUT.test(file) ||
      (!TEST_ONLY.test(file) &&
        closure.some((workspace) => file.startsWith(`${workspace.directory}/`))),
  );
  if (relevant.length > 0) {
    const shown = relevant.slice(0, 10).join(', ');
    const more = relevant.length > 10 ? ` and ${relevant.length - 10} more` : '';
    return { build: true, reason: `the export reads changed files: ${shown}${more}` };
  }
  return {
    build: false,
    reason: `none of the ${changedFiles.length} changed files reach the playground's build`,
  };
}

function git(repositoryRoot: string, ...arguments_: string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commitExists(repositoryRoot: string, sha: string): boolean {
  try {
    git(repositoryRoot, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** The change-based decision, computed for every deployment so its log shows the reasoning. */
export function decideFromRepository(
  repositoryRoot: string,
  previousSha: string | undefined,
  currentSha: string | undefined,
): Decision {
  if (previousSha === undefined || previousSha === '') {
    return { build: true, reason: 'there is no previous successful deployment to compare against' };
  }
  if (currentSha === undefined || currentSha === '') {
    return { build: true, reason: 'Vercel supplied no commit SHA' };
  }
  if (!commitExists(repositoryRoot, previousSha)) {
    // A force-push orphans the previous deployment's commit, and a branch can fall behind the
    // shallow clone's depth.
    return {
      build: true,
      reason: `previous deployment commit ${previousSha} is not in this clone`,
    };
  }
  const closure = dependencyClosure(readWorkspaces(repositoryRoot), PLAYGROUND_PACKAGE);
  console.log(`Playground dependency closure: ${closure.map((w) => w.directory).join(', ')}`);
  // Without `--no-renames`, Git reports a file moved out of the closure only by its destination,
  // and the site would silently keep a source it no longer has.
  const changedFiles = git(
    repositoryRoot,
    'diff',
    '--name-only',
    '--no-renames',
    previousSha,
    currentSha,
    '--',
  )
    .split('\n')
    .filter((line) => line !== '');
  return decideFromChanges({
    changedFiles,
    closure,
  });
}

/** Applies the preview policy over the change-based decision. */
export function decide(
  environment: string | undefined,
  commitMessage: string | undefined,
  fromChanges: () => Decision,
): Decision {
  let changes: Decision;
  try {
    changes = fromChanges();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    changes = { build: true, reason: `the change check failed: ${detail}` };
  }
  console.log(`Change check: ${changes.build ? 'build' : 'skip'} (${changes.reason})`);
  if (environment === 'production' || environment === undefined) return changes;
  // Only the subject line counts, so a commit body that merely mentions the token, as one
  // describing this very policy would, does not buy an hour-long build.
  const subject = commitMessage?.split('\n', 1)[0] ?? '';
  if (subject.includes(PREVIEW_OPT_IN)) {
    return { build: true, reason: `the commit subject opts this ${environment} deployment in` };
  }
  return {
    build: false,
    reason: `${environment} deployments build only when the commit subject contains ${PREVIEW_OPT_IN}`,
  };
}

if (import.meta.main) {
  const { vercelEnvironment, commitMessage, previousSha, commitSha } = ignoreStepEnvironment();
  console.log(
    `Bun ${Bun.version}; VERCEL_ENV=${vercelEnvironment ?? '(unset)'}; ` +
      `commit message ${commitMessage === undefined ? 'unset' : 'set'}`,
  );
  const decision = decide(vercelEnvironment, commitMessage, () =>
    decideFromRepository(
      git(process.cwd(), 'rev-parse', '--show-toplevel').trim(),
      previousSha,
      commitSha,
    ),
  );
  console.log(`${decision.build ? 'Building' : 'Skipping the build'}: ${decision.reason}.`);
  process.exitCode = decision.build ? 1 : 0;
}
