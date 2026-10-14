/**
 * `bun run test:browser:update:docker [--wait-for-load] [--source <ref>] [-- playwright args]`
 *
 * Regenerates the Linux visual baselines in the authoritative renderer (native
 * linux/arm64, Playwright jammy), from an exact commit, then writes a review
 * report and applies only the baselines whose pixels changed (plus added ones
 * and provenance). Ported from cinder's wrapper and rewritten for isolation
 * (COR-1512); see `scripts/browser-fixtures/visual-baselines.md`.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  buildBaselineDiffReport,
  filesToApply,
  parseRegeneratedList,
  writeBaselineDiffReport,
} from './baseline-diff-report.ts';
import {
  LINUX_BASELINE_DIRECTORY,
  REPOSITORY_ROOT,
  dockerImageTagForPlaywrightVersion,
  readRepositoryPins,
} from './baseline-provenance.ts';
import {
  DOCKERFILE_PATH,
  applyBaselines,
  archiveCommit,
  containerCommand,
  containerNameForRun,
  createDockerRunner,
  createRunDirectory,
  dockerArchitectureProblem,
  dockerBuildArguments,
  dockerRunArguments,
  extractArchive,
  hostOwnershipEnvironment,
  parseWrapperArguments,
  readDockerArchitecture,
  readHostLoad,
  resolveCommit,
  runContainerWithCleanup,
  waitForHostLoad,
} from './docker-baseline-runner.ts';

/** Build the renderer image and start a gated, archived container run. Shared with the visual run. */
export async function startRendererRun(
  mode: 'update' | 'visual',
  dockerArguments: readonly string[],
): Promise<{ exitCode: number; sha: string; runDirectory: string }> {
  const options = parseWrapperArguments(dockerArguments);
  const architectureProblem = dockerArchitectureProblem(readDockerArchitecture());
  if (architectureProblem !== undefined) throw new Error(architectureProblem);

  const gate = await waitForHostLoad(options.waitForLoad, {
    readLoad: () => readHostLoad(),
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    log: (message) => process.stdout.write(`${message}\n`),
  });
  if (!gate.ok) throw new Error(gate.reason);

  const sha = resolveCommit(options.source);
  const pins = readRepositoryPins();
  const imageTag = dockerImageTagForPlaywrightVersion(pins.playwrightVersion);
  const docker = createDockerRunner();
  process.stdout.write(`Building ${imageTag} (Bun ${pins.bunVersion})...\n`);
  const buildExit = await docker(dockerBuildArguments(pins, imageTag), { stdin: DOCKERFILE_PATH });
  if (buildExit !== 0) throw new Error(`docker build exited ${buildExit}.`);

  const runDirectory = await createRunDirectory(`corvidae-baselines-${mode}-`);
  const outputDirectory = join(runDirectory, 'out');
  await mkdir(outputDirectory, { recursive: true });
  const sourceArchive = join(runDirectory, 'source.tar');
  archiveCommit(sha, sourceArchive);

  const containerName = containerNameForRun();
  process.stdout.write(
    `Running ${mode} for ${sha} in ${containerName} (${gate.reading.load.toFixed(2)} load, waited ${Math.round(gate.waitedMilliseconds / 60_000)} minutes).\n`,
  );
  const exitCode = await runContainerWithCleanup(
    docker,
    dockerRunArguments({
      containerName,
      imageTag,
      outputDirectory,
      command: containerCommand(mode, options.forwarded),
      environment: {
        BASELINE_SOURCE_SHA: sha,
        CINDER_TEST_COMPONENTS: environmentConfiguration().cinderTestComponents,
        ...hostOwnershipEnvironment(),
      },
    }),
    containerName,
    sourceArchive,
  );
  process.stdout.write(`Container output: ${outputDirectory}\n`);
  return { exitCode, sha, runDirectory };
}

async function main(): Promise<number> {
  const { exitCode, sha, runDirectory } = await startRendererRun('update', process.argv.slice(2));
  if (exitCode !== 0) {
    process.stderr.write(`The update run exited ${exitCode}; no baselines were applied.\n`);
    return exitCode;
  }
  const outputDirectory = join(runDirectory, 'out');
  // Outside the repository: Playwright clears scripts/browser-fixtures/test-results on every run.
  const reportDirectory = join(runDirectory, 'report');
  const oldRoot = join(runDirectory, 'committed');
  await mkdir(oldRoot, { recursive: true });
  const oldArchive = join(runDirectory, 'committed.tar');
  archiveCommit(sha, oldArchive, [LINUX_BASELINE_DIRECTORY]);
  extractArchive(oldArchive, oldRoot);

  const regenerated = parseRegeneratedList(
    await Bun.file(join(outputDirectory, 'regenerated.txt')).text(),
    LINUX_BASELINE_DIRECTORY,
  );
  const report = await buildBaselineDiffReport({
    oldDirectory: join(oldRoot, LINUX_BASELINE_DIRECTORY),
    newDirectory: join(outputDirectory, 'linux'),
    regenerated,
    diffDirectory: join(reportDirectory, 'diffs'),
  });
  const written = await writeBaselineDiffReport(
    report,
    reportDirectory,
    `Visual baseline refresh rendered from ${sha}`,
  );
  const applied = filesToApply(report);
  await applyBaselines(
    join(outputDirectory, 'linux'),
    resolve(REPOSITORY_ROOT, LINUX_BASELINE_DIRECTORY),
    applied,
  );
  process.stdout.write(
    `Applied ${applied.length} baselines and provenance.json. Report: ${written.markdown}\n`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
