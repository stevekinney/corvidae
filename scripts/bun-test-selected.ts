/**
 * Runs `bun test` with the arguments given, narrowed to the test files `bun run check` selected
 * for this workspace (see `scripts/affected-tests.ts`). With no selection in force it is `bun test`.
 *
 * The lanes that do not write JUnit reports (`test:slow`) run through this, so they honour the
 * selection the way `scripts/bun-test-junit.ts` does for the fast lanes, and keep their own flags.
 *
 * Like `scripts/bun-test.ts`, it passes the repository's per-test deadline (see `scripts/test-deadlines.ts`).
 *
 * Usage: `bun <path>/scripts/bun-test-selected.ts <bun test arguments>`
 */

import {
  currentWorkspaceDirectory,
  narrowBunTestArguments,
  selectedFilesFor,
} from './affected-tests-manifest.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import { TEST_TIMEOUT_ARGUMENT } from './test-deadlines.ts';

async function main(): Promise<number> {
  const argumentsList = Bun.argv.slice(2);
  const selected = selectedFilesFor(rootScriptEnvironment(), currentWorkspaceDirectory());
  const narrowed =
    selected === null
      ? argumentsList
      : narrowBunTestArguments(argumentsList, selected, process.cwd());
  if (narrowed === null) {
    process.stdout.write(
      'bun-test-selected: no test file in this lane is reachable from the change; nothing to run.\n',
    );
    return 0;
  }
  const child = Bun.spawn(['bun', 'test', TEST_TIMEOUT_ARGUMENT, ...narrowed], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return child.exited;
}

if (import.meta.main) process.exitCode = await main();
