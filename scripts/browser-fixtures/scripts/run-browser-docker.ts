/**
 * `bun run test:browser:visual:docker [--source <ref>] [-- playwright args]`
 *
 * Runs the whole browser suite in block mode inside the authoritative renderer
 * (native linux/arm64, Playwright jammy) against an exact commit. Ported from
 * cinder's `run-browser-docker.ts` (COR-1512).
 *
 * It exits with the suite's status (except a scoped run whose only failure is the
 * terminal scope guard, which exits 0; see `decideVisualExit`) and writes `suite-results.json` (every
 * failing test, screenshot or behavioural) into the run directory. The
 * stability rule compares that with an `origin/main` control run the same way:
 * `bun scripts/browser-fixtures/scripts/suite-results.ts compare <run> <control>`.
 * Failure artefacts (traces, diff images) stay in the printed output directory.
 */
import { join } from 'node:path';

import { describeHostLoad } from './docker-baseline-runner.ts';
import { decideVisualExit } from './suite-results.ts';
import { startRendererRun } from './update-snapshots-docker.ts';

export const SUITE_RESULTS_FILE_NAME = 'suite-results.json';

async function main(): Promise<number> {
  const { exitCode, sha, runDirectory, hostLoad, results, componentScope } = await startRendererRun(
    'visual',
    process.argv.slice(2),
  );
  const resultsPath = join(runDirectory, SUITE_RESULTS_FILE_NAME);
  await Bun.write(
    resultsPath,
    `${JSON.stringify({ sha, exitCode, hostLoad, results: results ?? null }, null, 2)}\n`,
  );
  const failures = results?.failures ?? [];
  for (const failure of failures) {
    process.stdout.write(
      `  ${failure.screenshot ? 'screenshot' : 'behavioural'}: ${failure.title}\n`,
    );
  }
  // A run that never reached its tests has no failures to list; say so rather than read as clean.
  // A scoped run whose only failure is the terminal scope guard passes (COR-1575).
  const decision = decideVisualExit(exitCode, results, componentScope);
  if (decision.reason !== undefined) {
    (decision.exitCode === 0 ? process.stdout : process.stderr).write(`${decision.reason}\n`);
  }
  process.stdout.write(
    `Visual run against ${sha} exited ${exitCode} with ${failures.length} failing test(s); exiting ${decision.exitCode}. Host load: start ${describeHostLoad(hostLoad.start)}; end ${describeHostLoad(hostLoad.end)}. Results: ${resultsPath}\n`,
  );
  return decision.exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
