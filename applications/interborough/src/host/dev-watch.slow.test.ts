/**
 * The development build in the mode the `dev` script runs it: inside `bun --watch`, with the host's
 * modules loaded. Bundling in that process failed to resolve `@msgpack/msgpack` (COR-1642), so the
 * host builds in a child process; this runs the real thing, which takes a bundle's worth of
 * seconds, in the `test:slow` lane. The process runs at module scope, under the hang guard, so it
 * is not on Bun's per-test clock. Nothing asserts on how long it takes.
 */
import { afterAll, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-dev-watch-'));
const outdir = join(scratch, 'build');

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const child = spawnWithHangGuard(
  [process.execPath, '--watch', join(import.meta.dir, 'dev-watch-fixture.test-support.ts'), outdir],
  { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
);
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

it('builds the browser application under `bun --watch` after the host modules have loaded', () => {
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('BUILD OK');
  expect(existsSync(join(outdir, 'index.html'))).toBe(true);
});
