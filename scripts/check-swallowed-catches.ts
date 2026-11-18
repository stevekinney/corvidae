/**
 * Keep the host lock code from swallowing errors it did not mean to (COR-2463).
 *
 * Two review rounds on the lock reclaim races found the same class one instance at a time: a
 * `catch` that turned every failure (a permission error, a full disk) into "released", "gone" or
 * "not removed", so a real fault became a lock taken twice or a wait that never ended. In the
 * files below, a `catch` with no binding cannot look at the error's code, so it must open with a
 * comment saying why every failure is safe to treat the same way. A `catch (error)` that checks
 * the code and rethrows the rest needs nothing. This check runs from `lint:guards`.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

export const LOCK_FILES = [
  'scripts/run-exclusively.ts',
  'scripts/host-sessions.ts',
  'scripts/bun-test-pool.ts',
  'scripts/host-slots.ts',
];

/** The 1-based line of each `catch {` whose block does not open with a `//` comment. */
export function unexplainedCatches(source: string): number[] {
  const lines = source.split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (!/\bcatch\s*\{\s*$/.test(line)) return;
    const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '') ?? '';
    if (!next.trim().startsWith('//')) found.push(index + 1);
  });
  return found;
}

async function main(): Promise<void> {
  let failures = 0;
  for (const file of LOCK_FILES) {
    const handle = Bun.file(join(root, file));
    if (!(await handle.exists())) continue;
    for (const line of unexplainedCatches(await handle.text())) {
      failures += 1;
      process.stderr.write(
        `check-swallowed-catches — ${file}:${line}: a catch with no binding treats every failure alike. Catch (error), handle the codes you expect and rethrow the rest, or open the block with a comment saying why every failure is safe.\n`,
      );
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`check-swallowed-catches — OK (${LOCK_FILES.length} lock files).\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-swallowed-catches failed:', error);
    process.exitCode = 1;
  });
}
