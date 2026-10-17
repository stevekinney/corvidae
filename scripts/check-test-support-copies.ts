/**
 * Keep every byte-for-byte copy of a `@lostgradient/testing` module identical to its source.
 *
 * Nothing under `packages/weft` may import `@lostgradient/testing`: the mirror drops that private
 * development dependency for every target except Cinder, so the import would not resolve in the
 * Weft repository. The UI's test preload (`packages/weft/src/ui/tests/setup.ts`), its browser host
 * (`packages/weft/scripts/ui-browser/`), and the dashboard build compile Svelte with the plugin
 * instead, so `testing/testing/src/svelte-plugin.ts` and the `./environment-configuration.ts` it
 * imports are copied into `packages/weft/scripts/lib/`. That pair was the only vendoring the owner
 * allowed for the move (Weft UI project rulings, COR-1455).
 *
 * The hang guard (`testing/testing/src/hang-guard.ts`, COR-1541) is copied for the same reason,
 * and once more to `scripts/hang-guard.ts`: every test file starts its processes through it, the
 * Weft mirror cannot resolve the package, and the root package may not depend on a workspace,
 * because turbo folds every workspace the root depends on into the global hash.
 *
 * This check, run from the root `lint:root` script, fails when a copy is missing or differs from
 * its source.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** Each copy and the file it must equal, both relative to the repository root. */
export const TEST_SUPPORT_COPIES = [
  {
    source: 'testing/testing/src/svelte-plugin.ts',
    copy: 'packages/weft/scripts/lib/svelte-plugin.ts',
  },
  {
    source: 'testing/testing/src/environment-configuration.ts',
    copy: 'packages/weft/scripts/lib/environment-configuration.ts',
  },
  { source: 'testing/testing/src/hang-guard.ts', copy: 'packages/weft/scripts/lib/hang-guard.ts' },
  { source: 'testing/testing/src/hang-guard.ts', copy: 'scripts/hang-guard.ts' },
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
