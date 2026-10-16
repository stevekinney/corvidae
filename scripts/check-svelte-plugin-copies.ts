/**
 * Keep Weft's copy of the Svelte compile plugin identical to `@lostgradient/testing`'s.
 *
 * Nothing under `packages/weft` may import `@lostgradient/testing`: the mirror drops that private
 * development dependency for every target except Cinder, so the import would not resolve in the
 * Weft repository. The UI's test preload (`packages/weft/src/ui/tests/setup.ts`), its browser host
 * (`packages/weft/scripts/ui-browser/`), and the dashboard build compile Svelte with the plugin
 * instead, so `packages/testing/src/svelte-plugin.ts` and the `./environment-configuration.ts` it
 * imports are copied byte for byte into `packages/weft/scripts/lib/`. That pair is the only
 * vendoring the owner allowed for the move (Weft UI project rulings, COR-1455). This check, run
 * from the root `lint:root` script, fails when either copy is missing or differs from its source.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** Each copy and the file it must equal, both relative to the repository root. */
export const SVELTE_PLUGIN_COPIES = [
  {
    source: 'packages/testing/src/svelte-plugin.ts',
    copy: 'packages/weft/scripts/lib/svelte-plugin.ts',
  },
  {
    source: 'packages/testing/src/environment-configuration.ts',
    copy: 'packages/weft/scripts/lib/environment-configuration.ts',
  },
] as const;

/** The copies under `repositoryRoot` that are missing or differ from their sources. */
export async function findDriftedSvelteCopies(repositoryRoot: string): Promise<string[]> {
  const drifted: string[] = [];
  for (const { source, copy } of SVELTE_PLUGIN_COPIES) {
    const copied = Bun.file(join(repositoryRoot, copy));
    const original = await Bun.file(join(repositoryRoot, source)).bytes();
    if (!(await copied.exists()) || !Buffer.from(await copied.bytes()).equals(original)) {
      drifted.push(copy);
    }
  }
  return drifted;
}

async function main(): Promise<void> {
  const drifted = await findDriftedSvelteCopies(root);
  if (drifted.length === 0) {
    process.stdout.write('check-svelte-plugin-copies — OK (Weft’s copies match their sources).\n');
    return;
  }
  process.stderr.write(
    'check-svelte-plugin-copies — these copies differ from their @lostgradient/testing sources:\n',
  );
  for (const copy of drifted) {
    const { source } = SVELTE_PLUGIN_COPIES.find((entry) => entry.copy === copy) ?? {};
    process.stderr.write(`  ${copy} (copy of ${source})\n`);
  }
  process.stderr.write(
    'Copy the source over the copy unchanged; change the plugin in packages/testing, not in Weft.\n',
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-svelte-plugin-copies failed:', error);
    process.exitCode = 1;
  });
}
