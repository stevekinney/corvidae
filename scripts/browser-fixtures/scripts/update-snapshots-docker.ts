/**
 * `bun run test:browser:update:docker [--source <ref>] [--accept-behavioural-failures] [-- playwright args]`
 *
 * Regenerates the Linux visual baselines in the authoritative renderer (native
 * linux/arm64, Playwright jammy), from an exact commit, then writes a review
 * report and applies only the baselines whose pixels changed, added and renamed
 * ones, and provenance, and deletes orphans. A suite that completed with
 * behavioural failures is applied only with `--accept-behavioural-failures`; a
 * screenshot failure never is. Ported from cinder's wrapper and rewritten for
 * isolation (COR-1512); see `scripts/browser-fixtures/visual-baselines.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  buildBaselineDiffReport,
  filesToApply,
  filesToDelete,
  parseRegeneratedList,
  writeBaselineDiffReport,
  type NamingSources,
} from './baseline-diff-report.ts';
import {
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  dockerImageTagForPlaywrightVersion,
  parseBaselineProvenance,
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
  describeHostLoad,
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
  type HostLoadReading,
} from './docker-baseline-runner.ts';
import {
  CONTAINER_RESULTS_PATH,
  RESULTS_FILE_NAME,
  decideApply,
  nonPassingTests,
  summarizePlaywrightResults,
  type SuiteResults,
} from './suite-results.ts';

/** Build the renderer image and start an archived container run, recording host load. Shared with the visual run. */
export async function startRendererRun(
  mode: 'update' | 'visual',
  dockerArguments: readonly string[],
): Promise<{
  exitCode: number;
  sha: string;
  runDirectory: string;
  acceptBehaviouralFailures: boolean;
  results: SuiteResults | undefined;
  hostLoad: { start: HostLoadReading; end: HostLoadReading };
}> {
  const options = parseWrapperArguments(dockerArguments);
  const architectureProblem = dockerArchitectureProblem(readDockerArchitecture());
  if (architectureProblem !== undefined) throw new Error(architectureProblem);

  const loadAtStart = readHostLoad();

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
    `Running ${mode} for ${sha} in ${containerName}. Host at start: ${describeHostLoad(loadAtStart)}.\n`,
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
        PLAYWRIGHT_JSON_OUTPUT_FILE: CONTAINER_RESULTS_PATH,
        CINDER_TEST_COMPONENTS: environmentConfiguration().cinderTestComponents,
        ...hostOwnershipEnvironment(),
      },
    }),
    containerName,
    sourceArchive,
  );
  const loadAtEnd = readHostLoad();
  process.stdout.write(
    `Container output: ${outputDirectory}\nHost at end: ${describeHostLoad(loadAtEnd)}.\n`,
  );
  return {
    exitCode,
    sha,
    runDirectory,
    acceptBehaviouralFailures: options.acceptBehaviouralFailures,
    results: readSuiteResults(outputDirectory),
    hostLoad: { start: loadAtStart, end: loadAtEnd },
  };
}

/** The container's Playwright JSON report, summarized; undefined when the run produced none. */
export function readSuiteResults(outputDirectory: string): SuiteResults | undefined {
  const path = join(outputDirectory, RESULTS_FILE_NAME);
  return existsSync(path) ? summarizePlaywrightResults(readFileSync(path, 'utf8')) : undefined;
}

/** The fixture names the rendered commit's manifest declares, per component. */
export function manifestFixtureNames(manifestText: string): Map<string, string[]> {
  const parsed = JSON.parse(manifestText) as {
    entries?: { slug?: string; fixtures?: { name?: string }[] }[];
  };
  return new Map(
    (parsed.entries ?? []).map((entry) => [
      entry.slug ?? '',
      (entry.fixtures ?? []).map((fixture) => fixture.name ?? ''),
    ]),
  );
}

/** The rendered commit's spec sources, keyed by path relative to the tests directory. */
async function readSpecSources(directory: string): Promise<Map<string, string>> {
  if (!existsSync(directory)) return new Map();
  const files = await readdir(directory, { recursive: true });
  return new Map(
    files
      .filter((file) => file.endsWith('.ts'))
      .map((file) => [file.split('\\').join('/'), readFileSync(join(directory, file), 'utf8')]),
  );
}

async function main(): Promise<number> {
  const run = await startRendererRun('update', process.argv.slice(2));
  const { exitCode, sha, runDirectory, hostLoad, results } = run;
  const decision = decideApply(exitCode, results, run.acceptBehaviouralFailures);
  process.stdout.write(`${decision.reason}\n`);
  if (results === undefined) return exitCode === 0 ? 1 : exitCode;

  const outputDirectory = join(runDirectory, 'out');
  // Outside the repository: Playwright clears scripts/browser-fixtures/test-results on every run.
  const reportDirectory = join(runDirectory, 'report');
  const oldRoot = join(runDirectory, 'committed');
  await mkdir(oldRoot, { recursive: true });
  const oldArchive = join(runDirectory, 'committed.tar');
  archiveCommit(sha, oldArchive, [LINUX_BASELINE_DIRECTORY, 'scripts/browser-fixtures/tests']);
  extractArchive(oldArchive, oldRoot);

  const manifestPath = join(outputDirectory, 'manifest.json');
  const specSources = await readSpecSources(join(oldRoot, 'scripts/browser-fixtures/tests'));
  const namingSources: NamingSources = {
    manifestFixtures: existsSync(manifestPath)
      ? manifestFixtureNames(readFileSync(manifestPath, 'utf8'))
      : new Map(),
    specText: [...specSources.values()].join('\n'),
  };
  const regenerated = parseRegeneratedList(
    await Bun.file(join(outputDirectory, 'regenerated.txt')).text(),
    LINUX_BASELINE_DIRECTORY,
  );
  const report = await buildBaselineDiffReport({
    oldDirectory: join(oldRoot, LINUX_BASELINE_DIRECTORY),
    newDirectory: join(outputDirectory, 'linux'),
    regenerated,
    diffDirectory: join(reportDirectory, 'diffs'),
    namingSources,
    nonPassing: nonPassingTests(results),
    specSources,
  });
  const written = await writeBaselineDiffReport(
    report,
    reportDirectory,
    `Visual baseline refresh rendered from ${sha}`,
    { hostLoad, suite: { exitCode, results, decision } },
  );
  process.stdout.write(`Report: ${written.markdown}\n`);
  if (!decision.apply) return exitCode === 0 ? 1 : exitCode;

  // Provenance must come from this run: the in-container writer records the archived commit.
  const provenance = parseBaselineProvenance(
    readFileSync(join(outputDirectory, 'linux', PROVENANCE_FILE_NAME), 'utf8'),
  );
  if (provenance.renderedSourceSha !== sha || provenance.suiteExitCode !== exitCode) {
    process.stderr.write('provenance.json was not written by this run; nothing is applied.\n');
    return 1;
  }
  const applied = filesToApply(report);
  const deleted = filesToDelete(report);
  await applyBaselines(
    join(outputDirectory, 'linux'),
    resolve(REPOSITORY_ROOT, LINUX_BASELINE_DIRECTORY),
    applied,
    deleted,
  );
  process.stdout.write(
    `Applied ${applied.length} baselines and provenance.json; deleted ${deleted.length} orphans; kept ${report.restored.length} restored baselines.\n`,
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
