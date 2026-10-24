/**
 * `bun run test:browser:update:docker [--source <ref>] [--accept-behavioural-failures] [-- playwright args]`
 *
 * Regenerates the Linux visual baselines in the authoritative renderer (native
 * linux/arm64, Playwright jammy), from an exact commit, then writes a review
 * report and applies only the baselines whose pixels changed, added and renamed
 * ones, and provenance. A suite that completed with behavioural failures is
 * applied only with `--accept-behavioural-failures`; a screenshot failure never
 * is. The one exception is the terminal scope guard, which fails by design on a
 * run `CINDER_TEST_COMPONENTS` scoped away from the terminal: alone, it does not
 * block a scoped run (COR-1574). A run that did not complete normally (no report,
 * a webServer or globalSetup error, no executed test, or selected tests that
 * never ran) is never applied and removes nothing, and orphans are removed only
 * after a full, unfiltered run that regenerated baselines (COR-1537); a scoped run
 * keeps them and reports them as kept. A full run writes its own provenance; a
 * component-scoped run keeps the working tree's full-run record and adds a
 * `componentRenders` entry for each component it rendered (COR-1574). Ported from
 * cinder's wrapper and rewritten for isolation (COR-1512); see
 * `scripts/browser-fixtures/visual-baselines.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  buildBaselineDiffReport,
  filesToApply,
  filesToDelete,
  parseRegeneratedList,
  writeBaselineDiffReport,
  type BaselineDiffReport,
  type NamingSources,
} from './baseline-diff-report.ts';
import {
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  dockerImageTagForPlaywrightVersion,
  mergeScopedProvenance,
  normalizeProvenanceComponentScope,
  parseBaselineProvenance,
  readRepositoryPins,
  type BaselineComponentScope,
  type BaselineProvenance,
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
  extractCommitArchive,
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
  incompleteRunReasons,
  nonPassingTests,
  summarizePlaywrightResults,
  type SuiteResults,
} from './suite-results.ts';
import { provenanceComponentScope } from './update-snapshots.ts';

/** Build the renderer image and start an archived container run, recording host load. Shared with the visual run. */
export async function startRendererRun(
  mode: 'update' | 'visual',
  dockerArguments: readonly string[],
): Promise<{
  exitCode: number;
  sha: string;
  runDirectory: string;
  acceptBehaviouralFailures: boolean;
  /** Arguments forwarded to Playwright: any of them may narrow the selection. */
  forwarded: readonly string[];
  /** The `CINDER_TEST_COMPONENTS` scope the container ran under, as provenance records it. */
  componentScope: BaselineComponentScope;
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

  const rawComponentScope = environmentConfiguration().cinderTestComponents;
  const containerName = containerNameForRun();
  process.stdout.write(
    `Running ${mode} for ${sha} in ${containerName}. Host at start: ${describeHostLoad(loadAtStart)}.\n`,
  );
  // The run directory outlives the run for review, but the source archive is only the container's
  // input, and at about 130 MB it was most of what every kept run directory weighed.
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
        CINDER_TEST_COMPONENTS: rawComponentScope,
        ...hostOwnershipEnvironment(),
      },
    }),
    containerName,
    sourceArchive,
  ).finally(() => rm(sourceArchive, { force: true }));
  const loadAtEnd = readHostLoad();
  process.stdout.write(
    `Container output: ${outputDirectory}\nHost at end: ${describeHostLoad(loadAtEnd)}.\n`,
  );
  return {
    exitCode,
    sha,
    runDirectory,
    acceptBehaviouralFailures: options.acceptBehaviouralFailures,
    forwarded: options.forwarded,
    componentScope: normalizeProvenanceComponentScope(provenanceComponentScope(rawComponentScope)),
    results: readSuiteResults(outputDirectory),
    hostLoad: { start: loadAtStart, end: loadAtEnd },
  };
}

/**
 * The container's Playwright JSON report, summarized; undefined when the run produced none.
 * A report a crashed run left truncated throws, so nothing downstream reads it as empty.
 */
export function readSuiteResults(outputDirectory: string): SuiteResults | undefined {
  const path = join(outputDirectory, RESULTS_FILE_NAME);
  if (!existsSync(path)) return undefined;
  try {
    return summarizePlaywrightResults(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path} is not a complete Playwright JSON report; nothing is applied (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
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

export type UpdateRun = Awaited<ReturnType<typeof startRendererRun>>;

/** Where an update run applies: the working tree's Linux baselines, and how to read the committed ones. */
export type UpdateRunTarget = {
  baselineDirectory: string;
  /** Extracts the Linux baselines and specs of `sha` (never the working tree) under `destination`. */
  extractCommitted: (sha: string, destination: string) => void;
};

type Output = { stdout: (text: string) => void; stderr: (text: string) => void };

/** Decide, report, and apply a finished update run. Returns the wrapper's exit code. */
export async function applyUpdateRun(
  run: UpdateRun,
  target: UpdateRunTarget,
  output: Output,
): Promise<number> {
  const { exitCode, sha, runDirectory, hostLoad, results } = run;
  const decision = decideApply(
    exitCode,
    results,
    run.acceptBehaviouralFailures,
    run.componentScope,
  );
  const failed = exitCode === 0 ? 1 : exitCode;
  // An incomplete run's output says nothing about which baselines exist: every baseline it
  // never reached would read as an orphan. Refuse before building a report from it.
  if (results === undefined || incompleteRunReasons(results).length > 0) {
    output.stderr(`${decision.reason}\n`);
    return failed;
  }
  output.stdout(`${decision.reason}\n`);

  const outputDirectory = join(runDirectory, 'out');
  // Outside the repository: Playwright clears scripts/browser-fixtures/test-results on every run.
  const reportDirectory = join(runDirectory, 'report');
  const oldRoot = join(runDirectory, 'committed');
  await mkdir(oldRoot, { recursive: true });
  target.extractCommitted(sha, oldRoot);

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
    // Only a full, unfiltered run proves a baseline has no test: a scoped run never selects the rest.
    scope: { componentScope: run.componentScope, playwrightArguments: run.forwarded },
  });
  const written = await writeBaselineDiffReport(
    report,
    reportDirectory,
    `Visual baseline refresh rendered from ${sha}`,
    { hostLoad, suite: { exitCode, results, decision } },
  );
  output.stdout(`Report: ${written.markdown}\n`);
  if (!decision.apply) return failed;

  // Provenance must come from this run: the in-container writer records the archived commit.
  const rendered = parseBaselineProvenance(
    readFileSync(join(outputDirectory, 'linux', PROVENANCE_FILE_NAME), 'utf8'),
  );
  if (
    rendered.renderedSourceSha !== sha ||
    rendered.suiteExitCode !== exitCode ||
    JSON.stringify(rendered.componentScope) !== JSON.stringify(run.componentScope)
  ) {
    output.stderr('provenance.json was not written by this run; nothing is applied.\n');
    return 1;
  }
  if (regenerated.length === 0 && report.orphaned.length > 0) {
    output.stderr(
      `The run regenerated no baseline, so all ${report.orphaned.length} committed baselines read as orphans; nothing is applied.\n`,
    );
    return 1;
  }
  let provenance: BaselineProvenance;
  try {
    provenance = recordedProvenance(rendered, target.baselineDirectory);
  } catch (error) {
    output.stderr(
      `${error instanceof Error ? error.message : String(error)} Nothing is applied.\n`,
    );
    return 1;
  }
  const applied = filesToApply(report);
  await applyBaselines(
    join(outputDirectory, 'linux'),
    target.baselineDirectory,
    applied,
    filesToDelete(report),
    provenance,
  );
  output.stdout(`${appliedSummary(report, applied.length, rendered.componentScope)}\n`);
  if (report.orphanDisposition === 'kept' && report.orphaned.length > 0) {
    output.stdout(
      `The run was scoped (component scope ${JSON.stringify(run.componentScope)}, Playwright arguments ${JSON.stringify(run.forwarded)}), so it kept ${report.orphaned.length} orphan${report.orphaned.length === 1 ? '' : 's'}; only a full, unfiltered run removes them.\n`,
    );
  }
  return 0;
}

/**
 * The provenance a refresh writes. A render of the full component scope replaces the record.
 * A component-scoped render keeps the working tree's full-run record, so the committed set
 * still names the run that rendered the rest of it, and adds itself under `componentRenders`
 * (COR-1574).
 */
export function recordedProvenance(
  rendered: BaselineProvenance,
  baselineDirectory: string,
): BaselineProvenance {
  if (rendered.componentScope === 'all') return rendered;
  const path = join(baselineDirectory, PROVENANCE_FILE_NAME);
  if (!existsSync(path)) {
    throw new Error(
      `A scoped render adds to the working tree's full-run provenance.json, and ${path} does not exist.`,
    );
  }
  return mergeScopedProvenance(parseBaselineProvenance(readFileSync(path, 'utf8')), rendered);
}

function appliedSummary(
  report: BaselineDiffReport,
  applied: number,
  componentScope: BaselineComponentScope,
): string {
  const provenance =
    componentScope === 'all'
      ? 'provenance.json'
      : `provenance.json (component renders for ${componentScope.join(', ')})`;
  const orphans =
    report.orphanDisposition === 'deleted'
      ? `deleted ${report.orphaned.length} orphans`
      : `kept ${report.orphaned.length} orphans`;
  return `Applied ${applied} baselines and ${provenance}; ${orphans}; kept ${report.restored.length} restored baselines.`;
}

async function main(): Promise<number> {
  const run = await startRendererRun('update', process.argv.slice(2));
  return applyUpdateRun(
    run,
    {
      baselineDirectory: resolve(REPOSITORY_ROOT, LINUX_BASELINE_DIRECTORY),
      extractCommitted: (sha, destination) => {
        extractCommitArchive(
          sha,
          join(run.runDirectory, 'committed.tar'),
          [LINUX_BASELINE_DIRECTORY, 'scripts/browser-fixtures/tests'],
          destination,
        );
      },
    },
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  );
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
