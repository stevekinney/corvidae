/**
 * Keep every byte-for-byte copy of a `@lostgradient/testing` module identical to its source.
 *
 * Nothing under `packages/weft` may import `@lostgradient/testing`: the mirror drops that private
 * development dependency for every target except Cinder, so the import would not resolve in the
 * Weft repository.
 *
 * The hang guard (`testing/testing/src/hang-guard.ts`, COR-1541) is copied for that reason into
 * `packages/weft/scripts/lib/hang-guard.ts`, and once more to `scripts/hang-guard.ts`: every test
 * file starts its processes through it, the Weft mirror cannot resolve the package, and the root
 * package may not depend on a workspace, because turbo folds every workspace the root depends on
 * into the global hash.
 *
 * The wait helpers (`testing/testing/src/wait-until.ts`: `waitUntil` and `awakeTurns`, which end a
 * wait on the hang guard instead of a count of turns) are copied beside each hang-guard copy, for the
 * same reasons, and import it by the same relative name.
 *
 * Armorer cannot name `@lostgradient/testing` either (it is published under its own name, with no
 * workspace development dependency), so both modules are copied beside its MCP task fixtures
 * (`packages/armorer/test/fixtures/`).
 *
 * The temporary-path helper (`testing/testing/src/temporary-path.ts`, COR-1619) is copied into
 * `packages/bureau/src/test/temporary-path.ts` for a different reason: Bureau's public storage
 * fixtures (`src/test/storage-fixtures.ts`, exported from its index) allocate their paths with it,
 * so a consumer that imports Bureau loads it at runtime, and `@lostgradient/testing` is only a
 * development dependency there.
 *
 * This check, run from the root `lint:root` script, fails when a copy is missing or differs from
 * its source.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** Each copy and the file it must equal, both relative to the repository root. */
export const TEST_SUPPORT_COPIES = [
  { source: 'testing/testing/src/hang-guard.ts', copy: 'packages/weft/scripts/lib/hang-guard.ts' },
  { source: 'testing/testing/src/hang-guard.ts', copy: 'scripts/hang-guard.ts' },
  { source: 'testing/testing/src/wait-until.ts', copy: 'packages/weft/scripts/lib/wait-until.ts' },
  { source: 'testing/testing/src/wait-until.ts', copy: 'scripts/wait-until.ts' },
  {
    source: 'testing/testing/src/hang-guard.ts',
    copy: 'packages/armorer/test/fixtures/hang-guard.ts',
  },
  {
    source: 'testing/testing/src/wait-until.ts',
    copy: 'packages/armorer/test/fixtures/wait-until.ts',
  },
  {
    source: 'testing/testing/src/temporary-path.ts',
    copy: 'packages/bureau/src/test/temporary-path.ts',
  },
] as const;

/** The copies under `repositoryRoot` that are missing or differ from their sources. */
export async function findDriftedCopies(repositoryRoot: string): Promise<string[]> {
  const drifted: string[] = [];
  for (const { source, copy } of TEST_SUPPORT_COPIES) {
    const copied = Bun.file(join(repositoryRoot, copy));
    const original = await Bun.file(join(repositoryRoot, source)).bytes();
    if (!(await copied.exists()) || !Buffer.from(await copied.bytes()).equals(original)) {
      drifted.push(copy);
    }
  }
  return drifted;
}

async function main(): Promise<void> {
  const drifted = await findDriftedCopies(root);
  if (drifted.length === 0) {
    process.stdout.write('check-test-support-copies — OK (every copy matches its source).\n');
    return;
  }
  process.stderr.write(
    'check-test-support-copies — these copies differ from their @lostgradient/testing sources:\n',
  );
  for (const copy of drifted) {
    const { source } = TEST_SUPPORT_COPIES.find((entry) => entry.copy === copy) ?? {};
    process.stderr.write(`  ${copy} (copy of ${source})\n`);
  }
  process.stderr.write(
    'Copy the source over the copy unchanged; change the module in testing/testing, not in a copy.\n',
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-test-support-copies failed:', error);
    process.exitCode = 1;
  });
}
