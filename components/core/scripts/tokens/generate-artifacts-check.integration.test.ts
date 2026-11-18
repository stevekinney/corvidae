/**
 * `tokens:check` in the default `bun test` suite: every committed token
 * artifact — the generated stylesheets, resolved theme JSON, and
 * `documentation/tokens.md` — must match what `generate-artifacts.ts` renders
 * from the corpus. Without this, the check only ran on demand, and the
 * generator's Markdown formatting drifted from the repository's own Prettier
 * configuration unnoticed: `tokens:check` and `format:check` could not both
 * pass on the same `tokens.md`.
 *
 * Runs the checker as a subprocess, not in-process: this package's test
 * script passes `--conditions browser`, under which a static `prettier`
 * import resolves to the standalone bundle rather than the one the generator
 * uses when it runs as `tokens:generate`/`tokens:check`.
 */

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';

// COR-1334: the check regenerates every artifact and runs Prettier, which takes seconds on a
// loaded machine. Running it here, at module scope, keeps that subprocess off bun's five-second
// per-test clock; the test below only asserts on its settled result.
const scriptPath = new URL('./generate-artifacts.ts', import.meta.url).pathname;
const child = spawnWithHangGuard(['bun', scriptPath, '--check'], {
  cwd: new URL('../..', import.meta.url).pathname,
  stdout: 'pipe',
  stderr: 'pipe',
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

test('committed token artifacts match what the generator renders', () => {
  expect(exitCode, `tokens:check exited ${exitCode}:\n${stdout}${stderr}`).toBe(0);
});
