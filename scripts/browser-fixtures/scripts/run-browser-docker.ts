/**
 * `bun run test:browser:visual:docker [--wait-for-load] [--source <ref>] [-- playwright args]`
 *
 * Runs the whole browser suite in block mode inside the authoritative renderer
 * (native linux/arm64, Playwright jammy) against an exact commit. Every
 * behavioural and screenshot case must pass; this is the stability control and
 * the post-merge verification for the committed Linux baselines. Ported from
 * cinder's `run-browser-docker.ts` (COR-1512). Failure artefacts (traces, diff
 * images) are left in the printed container output directory.
 */
import { startRendererRun } from './update-snapshots-docker.ts';

async function main(): Promise<number> {
  const { exitCode, sha } = await startRendererRun('visual', process.argv.slice(2));
  process.stdout.write(`Visual run against ${sha} exited ${exitCode}.\n`);
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
