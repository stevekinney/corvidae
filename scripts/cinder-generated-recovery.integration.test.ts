import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { CINDER_GENERATED_OUTPUTS } from './ensure-cinder-generated.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

// Cinder's generated files are not tracked, so a fresh checkout has none. Paths that skip Turbo
// (Interborough's build entry, which the end-to-end server, the design-review capture and the
// release build call, and a `bun test` run inside the Cinder folder) must regenerate them.
//
// The scenario runs in an isolated detached worktree of HEAD, never the shared checkout: another
// test, a parallel Turbo task or another session reads the real files, and deleting them under it
// would be a flake. The worktree has no generated files (they are untracked), which is the fresh
// checkout under test. It is removed afterwards.

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

const scenario = await outcomeOf(async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-recovery-'));
  const copy = join(scratch, 'checkout');
  const cinder = join(copy, 'components/cinder');
  const missing = () =>
    CINDER_GENERATED_OUTPUTS.filter((output) => !existsSync(join(cinder, output)));
  try {
    const added = await run(['git', 'worktree', 'add', '--detach', copy, 'HEAD'], root);
    if (added.code !== 0) return void (setup = added);
    const installed = await run(['bun', 'install', '--frozen-lockfile'], copy);
    if (installed.code !== 0) return void (setup = installed);
    setup = { code: 0, output: '' };
    // Fresh checkout: nothing generated yet.
    freshMissing = missing();
    const build = await run(
      ['bun', 'scripts/build.ts', '--outdir', join(scratch, 'build')],
      join(copy, 'applications/interborough'),
    );
    buildResult = {
      ...build,
      missing: missing(),
      built: existsSync(join(scratch, 'build/index.html')),
    };
    // Remove the files again, so the Cinder test starts from a fresh checkout as well.
    for (const output of CINDER_GENERATED_OUTPUTS) await rm(join(cinder, output), { force: true });
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
  } finally {
    await run(['git', 'worktree', 'remove', '--force', copy], root);
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the isolated checkout is created and installed', () => {
  rethrow(scenario);
  expect(setup?.code, setup?.output).toBe(0);
  // The copy starts as a fresh checkout: every generated file is absent.
  expect(freshMissing).toEqual(CINDER_GENERATED_OUTPUTS);
});

test("Interborough's build entry regenerates Cinder's files and builds", () => {
  rethrow(scenario);
  expect(buildResult?.code, buildResult?.output).toBe(0);
  expect(buildResult?.built).toBe(true);
  expect(buildResult?.missing).toEqual([]);
});

test('a direct bun test in the Cinder folder regenerates the files and passes', () => {
  rethrow(scenario);
  expect(testResult?.code, testResult?.output).toBe(0);
  expect(testResult?.missing).toEqual([]);
});
