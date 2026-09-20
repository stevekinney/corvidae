import { describe, expect, it } from 'bun:test';

import { withOptionalStorageDriversHidden } from './block-optional-storage-drivers.test-support.ts';

const weftRoot = import.meta.dir + '/../..';

async function runFixture(relativePath: string): Promise<{ exitCode: number; stderr: string }> {
  return withOptionalStorageDriversHidden(weftRoot, async () => {
    const proc = Bun.spawn(['bun', relativePath], {
      cwd: weftRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  });
}

/**
 * Regression coverage for COR-1230: the mirror's consumer smoke test failed
 * importing `@lostgradient/weft`'s `.` and `./storage/resolve` entry points
 * with "Cannot find module '@libsql/client/web'" — a package declared only
 * as an optional peer dependency. The cause was `storage/turso.ts` importing
 * `@libsql/client/web` at module top level, so anything that merely
 * *imported* `resolve.ts` (or `index.ts`, which re-exports every backend)
 * pulled in Turso's driver whether or not Turso was ever selected.
 *
 * Each gate spawns a fresh Bun process with every optional storage-driver
 * peer dependency (`@libsql/client`, `@neondatabase/serverless`,
 * `better-sqlite3`, `lmdb`, `pg`) actually renamed out of `node_modules` for
 * the duration of the run, so it fails the exact same way a real consumer
 * without those peers installed would — the same shape of failure the
 * mirror's smoke test hit.
 */
describe('storage/resolve (optional-driver subprocess gates)', () => {
  it('resolves the memory backend when no optional storage driver is installed', async () => {
    const { exitCode, stderr } = await runFixture(
      'src/storage/resolve-without-optional-drivers-fixture.ts',
    );
    if (exitCode !== 0) {
      throw new Error(
        `resolve-without-optional-drivers fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);

  it("defers Turso's driver import to first use rather than construction", async () => {
    const { exitCode, stderr } = await runFixture('src/storage/turso-driver-deferred-fixture.ts');
    if (exitCode !== 0) {
      throw new Error(
        `turso-driver-deferred fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);
});
