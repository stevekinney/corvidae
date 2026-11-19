import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { CINDER_GENERATED_OUTPUTS } from './ensure-cinder-generated.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

// Cinder's generated files are not tracked, so a fresh checkout has none. Paths that skip Turbo
// (Interborough's build entry, which the end-to-end server, the design-review capture and the
// release build call, and a `bun test` run inside the Cinder folder) must regenerate them. Each
// scenario deletes the generated files from the working tree and runs the real entry.
//
// The files are shared with every other test of this checkout, so the scenarios run one after the
// other at module scope, and each entry regenerates under `ensureCinderGenerated`'s lock.

const root = join(import.meta.dir, '..');
const cinder = join(root, 'components/cinder');

function removeGenerated(): void {
  for (const output of CINDER_GENERATED_OUTPUTS) rmSync(join(cinder, output), { force: true });
}

const missing = () =>
  CINDER_GENERATED_OUTPUTS.filter((output) => !existsSync(join(cinder, output)));

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
let buildResult: Recorded | undefined;
let testResult: Recorded | undefined;

const interborough = await outcomeOf(async () => {
  removeGenerated();
  const outdir = await mkdtemp(join(tmpdir(), 'corvidae-recovery-build-'));
  try {
    const result = await run(
      ['bun', 'scripts/build.ts', '--outdir', join(outdir, 'build')],
      join(root, 'applications/interborough'),
    );
    buildResult = {
      ...result,
      missing: missing(),
      built: existsSync(join(outdir, 'build/index.html')),
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

const cinderTest = await outcomeOf(async () => {
  removeGenerated();
  const result = await run(
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
  testResult = { ...result, missing: missing() };
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
