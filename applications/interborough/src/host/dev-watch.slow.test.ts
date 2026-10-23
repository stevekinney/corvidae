/**
 * The development build in the mode the `dev` script runs it: inside `bun --watch`, with the host's
 * modules loaded. Bundling in that process failed to resolve `@msgpack/msgpack` (COR-1642), so the
 * host builds in a child process; this runs the real thing, which takes a bundle's worth of
 * seconds, in the `test:slow` lane. Nothing asserts on how long it takes.
 */
import { afterAll, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-dev-watch-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The work is a real bundle in a child of a watched process (about 5 s on a host at load 40, 3 s
// quiet), which is more than Bun's 5 s default. The bound only catches a hang: nothing asserts that
// the build is fast.
const HANG_BOUND_MILLISECONDS = 60_000;

it(
  'builds the browser application under `bun --watch` after the host modules have loaded',
  async () => {
    const outdir = join(scratch, 'build');
    const child = Bun.spawn(
      [
        process.execPath,
        '--watch',
        join(import.meta.dir, 'dev-watch-fixture.test-support.ts'),
        outdir,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('BUILD OK');
    expect(existsSync(join(outdir, 'index.html'))).toBe(true);
  },
  HANG_BOUND_MILLISECONDS,
);
