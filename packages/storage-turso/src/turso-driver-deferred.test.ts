import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  OPTIONAL_STORAGE_DRIVER_ENTRIES,
  withOptionalStorageDriversAbsent,
} from './turso-driver-sandbox.test-support.ts';

import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';

const tursoPackageRoot = import.meta.dir + '/..';

async function runFixture(
  relativePath: string,
  entry: string,
): Promise<{ exitCode: number; stderr: string }> {
  return withOptionalStorageDriversAbsent(tursoPackageRoot, async (sandboxRoot) => {
    const proc = spawnWithHangGuard(['bun', relativePath, entry], {
      cwd: sandboxRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  });
}

// This gate runs a fixture in a fresh Bun process in a sandbox without the optional storage drivers,
// which takes seconds on a loaded host. The scenario below runs at module scope, off Bun's
// per-test clock; its test rethrows the scenario's outcome.

/**
 * Regression coverage for COR-1230: the mirror's consumer smoke test failed importing
 * `@lostgradient/weft` with "Cannot find module '@libsql/client/web'", a package declared only as
 * an optional peer dependency. The cause was `storage/turso.ts` (now this package's `src/turso.ts` and `src/turso-web.ts`)
 * importing the driver at module top level, so anything that merely imported it (or `index.ts`,
 * which re-exports every backend) pulled in Turso's driver whether or not Turso was ever used.
 *
 * The gate spawns a fresh Bun process in a sandbox whose `node_modules` lacks every optional
 * storage-driver peer dependency (`@libsql/client`, `@neondatabase/serverless`, `better-sqlite3`,
 * `lmdb`, `pg`), so it fails the exact same way a real consumer without those peers installed
 * would. Constructing `TursoStorage` must succeed there; only its first operation may need the
 * driver.
 */
async function assertDriverDeferred(entry: string): Promise<void> {
  const { exitCode, stderr } = await runFixture('src/turso-driver-deferred-fixture.ts', entry);
  if (exitCode !== 0) {
    throw new Error(
      `turso-driver-deferred fixture failed for ${entry} (exit ${exitCode}).\nstderr:\n${stderr}`,
    );
  }
  expect(exitCode).toBe(0);
}

// The native entry's driver is `@libsql/client`; the web entry's is `@libsql/client/web`, which the
// sandbox removes together with the rest of the `@libsql` scope.
const tursoDriverDeferred = await outcomeOf(() => assertDriverDeferred('./index.ts'));
const tursoWebDriverDeferred = await outcomeOf(() => assertDriverDeferred('./web.ts'));

describe('storage-turso (optional-driver subprocess gate)', () => {
  it("defers Turso's driver import to first use rather than construction", () =>
    rethrow(tursoDriverDeferred));

  it("defers the web entry's driver import to first use rather than construction", () =>
    rethrow(tursoWebDriverDeferred));

  it('links every dependency but the optional drivers into a sandbox it removes afterwards', async () => {
    const installedDrivers = (): string[] =>
      OPTIONAL_STORAGE_DRIVER_ENTRIES.filter((entry) =>
        existsSync(join(tursoPackageRoot, 'node_modules', entry)),
      );
    const driversBefore = installedDrivers();
    const seen = await withOptionalStorageDriversAbsent(tursoPackageRoot, async (sandboxRoot) => ({
      sandboxRoot,
      drivers: OPTIONAL_STORAGE_DRIVER_ENTRIES.filter((entry) =>
        existsSync(join(sandboxRoot, 'node_modules', entry)),
      ),
      storage: existsSync(join(sandboxRoot, 'node_modules', '@lostgradient', 'storage')),
      source: existsSync(join(sandboxRoot, 'src', 'turso.ts')),
    }));
    expect(seen.drivers).toEqual([]);
    expect(seen.storage).toBe(true);
    expect(seen.source).toBe(true);
    expect(existsSync(seen.sandboxRoot)).toBe(false);
    // The shared install the rest of the suite and a concurrent typecheck read is untouched.
    expect(driversBefore).not.toEqual([]);
    expect(installedDrivers()).toEqual(driversBefore);
  });

  it('skips a dangling dependency link instead of failing to build the sandbox', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'weft-optional-drivers-dangling-'));
    try {
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      mkdirSync(join(packageRoot, 'node_modules', '@scope'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), '{}');
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');
      symlinkSync(
        join(packageRoot, 'missing'),
        join(packageRoot, 'node_modules', '@scope', 'gone'),
      );
      const linked = await withOptionalStorageDriversAbsent(packageRoot, async (sandboxRoot) =>
        existsSync(join(sandboxRoot, 'node_modules', '@scope', 'gone')),
      );
      expect(linked).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('fails to build the sandbox when a dependency link cannot be resolved for another reason', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'weft-optional-drivers-loop-'));
    try {
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      mkdirSync(join(packageRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), '{}');
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');
      // Two links that point at each other: realpath fails with ELOOP, not ENOENT.
      symlinkSync(
        join(packageRoot, 'node_modules', 'second'),
        join(packageRoot, 'node_modules', 'first'),
      );
      symlinkSync(
        join(packageRoot, 'node_modules', 'first'),
        join(packageRoot, 'node_modules', 'second'),
      );
      expect(
        await throwingRejectionOf(
          withOptionalStorageDriversAbsent(packageRoot, async () => 'unused'),
        ),
      ).toThrow(/ELOOP|too many/i);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
