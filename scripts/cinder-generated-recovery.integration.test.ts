import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { CINDER_GENERATED_OUTPUTS } from './ensure-cinder-generated.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

// Cinder's generated files are not tracked, so a fresh checkout has none. Paths that skip Turbo
// (the Interborough and browser fixture build entries and a `bun test` inside Cinder) must
// regenerate them.
//
// The scenario runs in an isolated detached worktree of HEAD, never the shared checkout: another
// test, a parallel Turbo task or another session reads the real files, and deleting them under it
// would be a flake. The worktree has no generated files (they are untracked), which is the fresh
// checkout under test. It is removed afterwards. Each child has its own hang guard so the
// install, builds and test cannot consume one another's deadline.

const root = join(import.meta.dir, '..');

async function run(command: string[], cwd: string): Promise<{ code: number; output: string }> {
  const child = spawnWithHangGuard(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

interface Recorded {
  code: number;
  output: string;
  missing: string[];
  built?: boolean;
}
let setup: { code: number; output: string } | undefined;
let freshMissing: string[] = [];
let buildResult: Recorded | undefined;
let testResult: Recorded | undefined;
let fixturesResult: Recorded | undefined;

const scratch = await mkdtemp(join(tmpdir(), 'corvidae-recovery-'));
const copy = join(scratch, 'checkout');
const cinder = join(copy, 'components/cinder');
const missing = () =>
  CINDER_GENERATED_OUTPUTS.filter((output) => !existsSync(join(cinder, output)));

async function removeGeneratedFiles(): Promise<void> {
  for (const output of CINDER_GENERATED_OUTPUTS) await rm(join(cinder, output), { force: true });
}

const checkout = await outcomeOf(async () => {
  const added = await run(['git', 'worktree', 'add', '--detach', copy, 'HEAD'], root);
  if (added.code !== 0) return void (setup = added);
  setup = await run(['bun', 'install', '--frozen-lockfile'], copy);
  freshMissing = missing();
});

const interborough = await outcomeOf(async () => {
  if (checkout !== undefined || setup?.code !== 0) return;
  const build = await run(
    ['bun', 'scripts/build.ts', '--outdir', join(scratch, 'build')],
    join(copy, 'applications/interborough'),
  );
  buildResult = {
    ...build,
    missing: missing(),
    built: existsSync(join(scratch, 'build/index.html')),
  };
});

const cinderTest = await outcomeOf(async () => {
  if (checkout !== undefined || setup?.code !== 0) return;
  await removeGeneratedFiles();
  const direct = await run(
    [
      'bun',
      'test',
      '--conditions',
      'browser',
      '--conditions',
      'svelte',
      'src/token-root-exports.test.ts',
    ],
    cinder,
  );
  testResult = { ...direct, missing: missing() };
});

const browserFixtures = await outcomeOf(async () => {
  if (checkout !== undefined || setup?.code !== 0) return;
  await removeGeneratedFiles();
  const build = await run(['bun', 'scripts/build.ts'], join(copy, 'scripts/browser-fixtures'));
  fixturesResult = {
    ...build,
    missing: missing(),
    built: existsSync(join(copy, 'scripts/browser-fixtures/build/index.html')),
  };
});

const cleanup = await outcomeOf(async () => {
  await run(['git', 'worktree', 'remove', '--force', copy], root);
  await rm(scratch, { recursive: true, force: true });
});

test('the isolated checkout is created and installed', () => {
  rethrow(checkout);
  expect(setup?.code, setup?.output).toBe(0);
  // The copy starts as a fresh checkout: every generated file is absent.
  expect(freshMissing).toEqual(CINDER_GENERATED_OUTPUTS);
});

test("Interborough's build entry regenerates Cinder's files and builds", () => {
  rethrow(interborough);
  expect(buildResult?.code, buildResult?.output).toBe(0);
  expect(buildResult?.built).toBe(true);
  expect(buildResult?.missing).toEqual([]);
});

test('a direct bun test in the Cinder folder regenerates the files and passes', () => {
  rethrow(cinderTest);
  expect(testResult?.code, testResult?.output).toBe(0);
  expect(testResult?.missing).toEqual([]);
});

test('the browser fixture build generates Cinder utilities in a fresh checkout', () => {
  rethrow(browserFixtures);
  rethrow(cleanup);
  expect(fixturesResult?.code, fixturesResult?.output).toBe(0);
  expect(fixturesResult?.built).toBe(true);
  expect(fixturesResult?.missing).toEqual([]);
});
