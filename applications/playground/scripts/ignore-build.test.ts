import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'ignore-build.sh');
const vercelConfigPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json');

const absentCommit = 'deadbeef'.repeat(5);
const touchedPathCases = [
  ['applications/playground/package.json', 1],
  ['packages/weft/package.json', 1],
  ['scripts/mirror/package-map.json', 1],
  ['tsconfig.json', 1],
  ['applications/example/package.json', 0],
  ['scripts/mirror/sync.ts', 0],
] as const;

const repository = await mkdtemp(join(tmpdir(), 'playground-ignore-build-'));
afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

function git(...arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], { cwd: repository });
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function commitTouching(path: string): Promise<string> {
  git('checkout', '--quiet', '--detach', base);
  const file = join(repository, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `changed ${path}\n`);
  git('add', '--all');
  git('commit', '--quiet', '-m', `touch ${path}`);
  return git('rev-parse', 'HEAD');
}

/** Exit code of the ignore script run from the application directory, as Vercel runs it. */
function ignoreExit(previous: string | undefined, current: string): number {
  const environment: Record<string, string> = { ...process.env, VERCEL_GIT_COMMIT_SHA: current };
  if (previous === undefined) delete environment['VERCEL_GIT_PREVIOUS_SHA'];
  else environment['VERCEL_GIT_PREVIOUS_SHA'] = previous;
  const result = Bun.spawnSync(['sh', scriptPath], {
    cwd: join(repository, 'applications/playground'),
    env: environment,
  });
  return result.exitCode;
}

/**
 * Every git commit and every run of the ignore script happens here, at module scope: both are
 * real processes, and running them inside the tests put each one on Bun's five-second per-test
 * clock. The tests below assert on the exit codes recorded here.
 */
async function commitBase(): Promise<string> {
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  for (const path of [
    'applications/playground/package.json',
    'applications/example/package.json',
    'packages/weft/package.json',
    'scripts/mirror/package-map.json',
    'scripts/mirror/sync.ts',
    'tsconfig.json',
  ]) {
    await mkdir(join(repository, dirname(path)), { recursive: true });
    await writeFile(join(repository, path), `${path}\n`);
  }
  git('add', '--all');
  git('commit', '--quiet', '-m', 'base');
  return git('rev-parse', 'HEAD');
}

const base = await commitBase();
const touchedPathExits = new Map<string, number>();
for (const [path] of touchedPathCases) {
  touchedPathExits.set(path, ignoreExit(base, await commitTouching(path)));
}
const exitWithoutPreviousDeployment = ignoreExit(undefined, base);
const exitWithAbsentPreviousDeployment = ignoreExit(absentCommit, base);
const exitWithAbsentCurrentCommit = ignoreExit(base, absentCommit);

describe('ignore-build.sh', () => {
  test.each(touchedPathCases)('a commit touching only %s exits %i', (path, expected) => {
    expect(touchedPathExits.get(path)).toBe(expected);
  });

  test('builds when there is no previous deployment to compare against', () => {
    expect(exitWithoutPreviousDeployment).toBe(1);
  });

  // Vercel sets the previous SHA to the branch's last successful deployment. A force-push after
  // an amend or rebase orphans that commit, and a branch can also fall further behind than the
  // shallow clone reaches; either way the object is absent and `git diff` exits 128, which Vercel
  // reports as a failed deployment rather than a build. Because a failed deployment is not a
  // successful one, the previous SHA should not advance past it either.
  test('builds when the previous deployment commit is not in the clone', () => {
    expect(exitWithAbsentPreviousDeployment).toBe(1);
  });

  test('builds whenever the comparison itself fails, rather than exiting with git’s error code', () => {
    expect(exitWithAbsentCurrentCommit).toBe(1);
  });

  test('is what vercel.json runs, within the 256-character limit Vercel enforces', async () => {
    const config = JSON.parse(await readFile(vercelConfigPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['installCommand', 'buildCommand', 'ignoreCommand']) {
      expect(String(config[key]).length).toBeLessThanOrEqual(256);
    }
    expect(config['ignoreCommand']).toBe('sh scripts/ignore-build.sh');
  });
});
