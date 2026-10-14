/**
 * The result file shape `measure-playground.ts` writes, and the pure rules that read it (CIN-585):
 * summarizing a Playwright JSON report, checking that a baseline and a candidate are comparable,
 * and turning two result files into the selection rule's observations.
 */
import type {
  HostLoad,
  LoadWait,
  PinnedEnvironment,
  SourceState,
} from './measure-playground-environment.ts';
import type { ArtifactInventory } from './measure-playground-inventory.ts';
import type { TreeSampleSeries } from './measure-playground-process-tree.ts';
import type { MetricObservation, Temperature } from './measure-playground-statistics.ts';

export const RESULT_SCHEMA = 'cin-585-playground-measurements/1';

export type ChildMeasurement = {
  command: string[];
  exitCode: number | null;
  signalCode: string | null;
  /** Spawn to exit, from the measuring process's monotonic clock. */
  wallMilliseconds: number;
  /** `Bun.Subprocess.resourceUsage().maxRSS`: this child's own high-water mark, in bytes. */
  childMaxResidentBytes: number | null;
  userCpuMicroseconds: number | null;
  systemCpuMicroseconds: number | null;
  /** The 100 ms owned-tree observer's series, without per-sample detail. */
  tree: Omit<TreeSampleSeries, 'samples'>;
  /** Pids the observer saw that were still alive after the child exited. */
  survivingPids: number[];
  logPath: string;
};

type SampleBase = {
  pair: number;
  temperature: Temperature;
  loadWait: LoadWait;
  hostLoadBefore: HostLoad;
  hostLoadAfter: HostLoad;
  source: SourceState;
  child: ChildMeasurement;
};

export type StaticExportSample = SampleBase & {
  inventory: ArtifactInventory;
  routeCount: number;
  exporterSummary: {
    renderedFiles: number;
    sidebarComponents: number;
    reportedSeconds: number;
  } | null;
};

export type ServerReadySample = SampleBase & {
  /** Null when the server missed the readiness limit or exited first; see `readyOutcome`. */
  spawnToReadyMilliseconds: number | null;
  readyOutcome: 'ready' | 'deadline-exceeded' | 'exited';
  /** The existing `playwright.config.ts` web-server limit, reused unchanged. */
  readyDeadlineMilliseconds: number;
  /** The owned tree observed from spawn until the first positive `/ready`. */
  treeUntilReady: Omit<TreeSampleSeries, 'samples'>;
  prebuildSummary: {
    succeeded: number;
    total: number;
    selfReportedPeakResidentMegabytes: number;
  } | null;
};

export type PlaywrightSample = SampleBase & { report: PlaywrightReportSummary | null };

export type PrerequisiteSample = Omit<SampleBase, 'pair' | 'temperature'> & { pair: number };

export type MeasurementResults = {
  schema: typeof RESULT_SCHEMA;
  label: string;
  startedAt: string;
  finishedAt: string;
  environment: PinnedEnvironment;
  routeInventory: string[];
  definitions: Record<string, string>;
  prerequisites: PrerequisiteSample[];
  staticExport: StaticExportSample[];
  serverReady: ServerReadySample[];
  playwright: PlaywrightSample[];
  probes: { navigation?: ProbeMeasurement; rebuild?: ProbeMeasurement };
};

export type ProbeMeasurement = {
  loadWait: LoadWait;
  child: ChildMeasurement;
  result: unknown;
  error?: string;
};

export type PlaywrightReportSummary = {
  reportedDurationMilliseconds: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  testResults: number;
  /** Sum of every test result's own duration: test execution without startup or the web server. */
  testExecutionMilliseconds: number;
};

type PlaywrightSuite = {
  specs?: { tests?: { results?: { duration?: number }[] }[] }[];
  suites?: PlaywrightSuite[];
};

type PlaywrightReport = PlaywrightSuite & {
  stats?: {
    duration?: number;
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
};

function collectResultDurations(suite: PlaywrightSuite, durations: number[]): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) durations.push(result.duration ?? 0);
    }
  }
  for (const child of suite.suites ?? []) collectResultDurations(child, durations);
}

/** Summarize a Playwright JSON report. */
export function summarizePlaywrightReport(report: PlaywrightReport): PlaywrightReportSummary {
  const durations: number[] = [];
  collectResultDurations(report, durations);
  return {
    reportedDurationMilliseconds: report.stats?.duration ?? 0,
    expected: report.stats?.expected ?? 0,
    unexpected: report.stats?.unexpected ?? 0,
    flaky: report.stats?.flaky ?? 0,
    skipped: report.stats?.skipped ?? 0,
    testResults: durations.length,
    testExecutionMilliseconds: durations.reduce((sum, duration) => sum + duration, 0),
  };
}

/** Reasons a baseline and a candidate cannot be compared; empty when they can. */
export function comparabilityProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const problems: string[] = [];
  if (baseline.environment.sourceSha !== candidate.environment.sourceSha) {
    problems.push(
      `Source SHA differs: baseline ${baseline.environment.sourceSha}, candidate ${candidate.environment.sourceSha}.`,
    );
  }
  if (baseline.environment.lockfileSha256 !== candidate.environment.lockfileSha256) {
    problems.push('Lockfile digest differs.');
  }
  if (JSON.stringify(baseline.routeInventory) !== JSON.stringify(candidate.routeInventory)) {
    problems.push('Route inventories differ; the experiment must run on identical routes.');
  }
  const dirtyBaseline = [...baseline.staticExport, ...baseline.serverReady].some(
    (sample) => sample.source.dirtyPaths.length > 0,
  );
  if (dirtyBaseline) problems.push('A baseline sample ran against a dirty working tree.');
  for (const [label, results] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ] as const) {
    for (const failure of runFailures(results)) problems.push(`${label}: ${failure}`);
  }
  return problems;
}

/** Samples that did not complete: a failed export or Playwright run, a readiness miss, a failed probe. */
export function runFailures(results: MeasurementResults): string[] {
  const failures: string[] = [];
  for (const sample of results.staticExport) {
    if (sample.child.exitCode !== 0) {
      failures.push(
        `Static export pair ${sample.pair} ${sample.temperature} exited ${sample.child.exitCode}.`,
      );
    }
  }
  for (const sample of results.serverReady) {
    if (sample.readyOutcome !== 'ready') {
      failures.push(
        `Server readiness pair ${sample.pair} ${sample.temperature}: ${sample.readyOutcome} (limit ${sample.readyDeadlineMilliseconds} ms).`,
      );
    }
  }
  for (const sample of results.playwright) {
    if (sample.child.exitCode !== 0) {
      failures.push(
        `Playwright pair ${sample.pair} ${sample.temperature} exited ${sample.child.exitCode}.`,
      );
    }
  }
  for (const [name, probe] of Object.entries(results.probes)) {
    if (probe.error !== undefined) failures.push(`The ${name} probe failed. ${probe.error}`);
  }
  return failures;
}

function valuesFor<T extends { temperature: Temperature }>(
  samples: readonly T[],
  temperature: Temperature,
  read: (sample: T) => number,
): number[] {
  return samples.filter((sample) => sample.temperature === temperature).map(read);
}

/** Build the selection rule's observations: each primary metric, per subject, cold and warm. */
export function observationsFromResults(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): MetricObservation[] {
  const observations: MetricObservation[] = [];
  for (const temperature of ['cold', 'warm'] as const) {
    const pairs: [
      Omit<MetricObservation, 'temperature' | 'baseline' | 'candidate'>,
      (results: MeasurementResults) => number[],
    ][] = [
      [
        { metric: 'staticExportMilliseconds' },
        (results) =>
          valuesFor(results.staticExport, temperature, (sample) => sample.child.wallMilliseconds),
      ],
      [
        { metric: 'serverSpawnToReadyMilliseconds' },
        (results) =>
          valuesFor(
            results.serverReady,
            temperature,
            (sample) => sample.spawnToReadyMilliseconds ?? Number.NaN,
          ),
      ],
      [
        { metric: 'processTreePeakResidentBytes', subject: 'static-export' },
        (results) =>
          valuesFor(
            results.staticExport,
            temperature,
            (sample) => sample.child.tree.peakResidentBytes,
          ),
      ],
      [
        { metric: 'processTreePeakResidentBytes', subject: 'server-until-ready' },
        (results) =>
          valuesFor(
            results.serverReady,
            temperature,
            (sample) => sample.treeUntilReady.peakResidentBytes,
          ),
      ],
    ];
    for (const [identity, read] of pairs) {
      const baselineValues = read(baseline);
      const candidateValues = read(candidate);
      if (baselineValues.length === 0 || candidateValues.length === 0) continue;
      observations.push({
        ...identity,
        temperature,
        baseline: baselineValues,
        candidate: candidateValues,
      });
    }
  }
  return observations;
}
