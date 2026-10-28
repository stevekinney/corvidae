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
import { recordedChildEnvironment } from './measure-playground-environment.ts';
import type { ArtifactInventory } from './measure-playground-inventory.ts';
import type { TreeSampleSeries } from './measure-playground-process-tree.ts';
import type { MetricObservation, Temperature } from './measure-playground-statistics.ts';

/**
 * A tree series as a result file records it, without per-sample detail. The failure fields are
 * optional because results recorded before the observer kept its failures do not carry them.
 */
export type RecordedTreeSeries = Omit<
  TreeSampleSeries,
  'samples' | 'failedReads' | 'failureMessages' | 'pressureReadings' | 'maximumPressureLevel'
> &
  Partial<
    Pick<
      TreeSampleSeries,
      'failedReads' | 'failureMessages' | 'pressureReadings' | 'maximumPressureLevel'
    >
  >;

export const RESULT_SCHEMA = 'cin-585-playground-measurements/2';

export type ChildMeasurement = {
  command: string[];
  exitCode: number | null;
  signalCode: string | number | null;
  /** Spawn to exit, from the measuring process's monotonic clock. */
  wallMilliseconds: number;
  /** `Bun.Subprocess.resourceUsage().maxRSS`: this child's own high-water mark, in bytes. */
  childMaxResidentBytes: number | null;
  userCpuMicroseconds: number | null;
  systemCpuMicroseconds: number | null;
  /** The 100 ms owned-tree observer's series, without per-sample detail. */
  tree: RecordedTreeSeries;
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
  /** The harness's readiness censor in force for this sample (900 s from CIN-588). */
  readyDeadlineMilliseconds: number;
  /** The owned tree observed from spawn until the first positive `/ready`. */
  treeUntilReady: RecordedTreeSeries;
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
  // Validate both files' schema first: no other rule may read a file this script did not write.
  const schemaProblems = (
    [
      ['baseline', baseline],
      ['candidate', candidate],
    ] as const
  )
    .filter(([, results]) => results.schema !== RESULT_SCHEMA)
    .map(
      ([label, results]) =>
        `${label} schema is ${JSON.stringify(results.schema)}; expected ${JSON.stringify(RESULT_SCHEMA)}.`,
    );
  if (schemaProblems.length > 0) return schemaProblems;
  const problems: string[] = [...environmentProblems(baseline, candidate)];
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
  const untrackedBaseline = [...baseline.staticExport, ...baseline.serverReady].some(
    (sample) => sample.source.untrackedPaths.length > 0,
  );
  if (untrackedBaseline) {
    problems.push('A baseline sample ran with untracked files in the working tree.');
  }
  problems.push(...childEnvironmentProblems(baseline, candidate));
  problems.push(...candidateChangeProblems(baseline, candidate));
  // Only failures in the samples the selection rule reads make results incomparable. Playwright
  // and probe failures are reported by `runFailures` but feed no primary metric.
  for (const [label, results] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ] as const) {
    for (const failure of primaryMetricFailures(results)) problems.push(`${label}: ${failure}`);
    for (const failure of primarySurvivorFailures(results)) problems.push(`${label}: ${failure}`);
    for (const flag of memoryPressureFlags(results)) problems.push(`${label}: ${flag}`);
  }
  problems.push(...coverageProblems(baseline, candidate));
  problems.push(...prebuildWorkloadProblems(baseline, candidate));
  return problems;
}

/**
 * Both sides must have prebuilt the same workload, and that workload must be every sidebar
 * component the static export documents. A candidate that narrows the eager prebuild would read
 * as faster while doing less, so it is refused rather than selectable.
 */
export function prebuildWorkloadProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const both = [baseline, candidate];
  const totals = [
    ...new Set(
      both.flatMap((results) =>
        results.serverReady.flatMap((sample) =>
          sample.prebuildSummary === null ? [] : [sample.prebuildSummary.total],
        ),
      ),
    ),
  ].toSorted((left, right) => left - right);
  const exportedComponents = both.flatMap((results) =>
    results.staticExport.map((sample) => sample.exporterSummary?.sidebarComponents ?? null),
  );
  const expected = [...new Set(exportedComponents)];
  const problems: string[] = [];
  if (totals.length > 1) {
    problems.push(
      `Readiness samples prebuilt different workloads: ${totals.join(', ')} page bundles.`,
    );
  }
  if (expected.length !== 1 || expected[0] === null) {
    problems.push(
      'Static exports do not report one sidebar component count to check the prebuild workload against.',
    );
  } else if (totals.length === 1 && totals[0] !== expected[0]) {
    problems.push(
      `Readiness samples prebuilt ${totals[0]} page bundles, but the static exports document ${expected[0]} sidebar components.`,
    );
  }
  return problems;
}

/** Measured children must have run with the same forced environment (`NODE_ENV` and the rest). */
function childEnvironmentProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const expected = JSON.stringify(recordedChildEnvironment());
  return (
    [
      ['baseline', baseline],
      ['candidate', candidate],
    ] as const
  )
    .filter(
      ([, results]) => JSON.stringify(results.environment.childEnvironment ?? null) !== expected,
    )
    .map(
      ([label, results]) =>
        `${label}: measured children did not run with the normalized environment: recorded ${JSON.stringify(results.environment.childEnvironment ?? null)}, expected ${expected}.`,
    );
}

/** The working-tree change a result ran against: its diff and untracked-content digests. */
function workingTreeFingerprint(results: MeasurementResults): string | null {
  const diff = results.environment.workingTreeDiffSha256;
  const untracked = results.environment.untrackedSha256 ?? null;
  return diff === null && untracked === null ? null : `${diff ?? 'none'}+${untracked ?? 'none'}`;
}

/**
 * Paths whose change would alter the measurement rather than the measured code: the harness
 * modules and the Playground modules they import.
 */
export function isMeasurementHarnessPath(path: string): boolean {
  return (
    /^applications\/playground\/scripts\/measure-playground[^/]*$/u.test(path) ||
    path === 'applications/playground/src/playground-paths.ts' ||
    path === 'applications/playground/src/environment-configuration.ts'
  );
}

/** A candidate must change something of its own, and never the harness that measures it. */
function candidateChangeProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const problems: string[] = [];
  const candidateFingerprint = workingTreeFingerprint(candidate);
  if (candidateFingerprint === null || candidateFingerprint === workingTreeFingerprint(baseline)) {
    problems.push(
      'The candidate has no working-tree change of its own, so there is nothing to select.',
    );
  }
  const changedPaths = new Set([
    ...candidate.environment.dirtyPaths,
    ...candidate.environment.untrackedPaths,
    ...primarySamples(candidate).flatMap(({ source }) => [
      ...source.dirtyPaths,
      ...source.untrackedPaths,
    ]),
  ]);
  const harnessPaths = [...changedPaths].filter(isMeasurementHarnessPath).toSorted();
  if (harnessPaths.length > 0) {
    problems.push(`The candidate changes the measurement harness: ${harnessPaths.join(', ')}.`);
  }
  return problems;
}

/** The fields that must match for two runs to be the same environment. */
function environmentFields(results: MeasurementResults): [string, unknown][] {
  const environment = results.environment;
  return [
    ['Bun version', environment.versions.bun],
    ['Svelte version', environment.versions.svelte],
    ['platform', environment.operatingSystem.platform],
    ['OS release', environment.operatingSystem.release],
    ['architecture', environment.operatingSystem.architecture],
    ['CPU model', environment.operatingSystem.cpuModel],
    ['logical processors', environment.logicalProcessors],
    ['total memory', environment.totalMemoryBytes],
    ['container memory limit', environment.containerMemoryLimit],
  ];
}

/** Results from different hosts or runtimes are not comparable. */
export function environmentProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const candidateFields = new Map(environmentFields(candidate));
  return environmentFields(baseline)
    .filter(([field, value]) => candidateFields.get(field) !== value)
    .map(
      ([field, value]) =>
        `Environment differs in ${field}: baseline ${JSON.stringify(value)}, candidate ${JSON.stringify(candidateFields.get(field))}.`,
    );
}

/** The protocol's three cold/warm pairs: fewer samples, as in a smoke run, can never select. */
export const MINIMUM_SAMPLES_PER_OBSERVATION = 3;

/** Every primary subject needs both temperatures, with equal counts of at least the minimum. */
export function coverageProblems(
  baseline: MeasurementResults,
  candidate: MeasurementResults,
): string[] {
  const problems: string[] = [];
  const subjects: [
    string,
    (results: MeasurementResults) => readonly { temperature: Temperature }[],
  ][] = [
    ['staticExportMilliseconds', (results) => results.staticExport],
    ['serverSpawnToReadyMilliseconds', (results) => results.serverReady],
  ];
  for (const [subject, samplesOf] of subjects) {
    for (const temperature of ['cold', 'warm'] as const) {
      const count = (results: MeasurementResults): number =>
        samplesOf(results).filter((sample) => sample.temperature === temperature).length;
      const baselineCount = count(baseline);
      const candidateCount = count(candidate);
      if (baselineCount !== candidateCount || baselineCount < MINIMUM_SAMPLES_PER_OBSERVATION) {
        problems.push(
          `${subject}/${temperature}: baseline has ${baselineCount} samples and candidate ${candidateCount}; each side needs the same count, at least ${MINIMUM_SAMPLES_PER_OBSERVATION}.`,
        );
      }
    }
  }
  return problems;
}

type LabelledSample = { label: string; source: SourceState };

function primarySamples(results: MeasurementResults): LabelledSample[] {
  return [
    ...results.staticExport.map((sample) => ({
      label: `Static export pair ${sample.pair} ${sample.temperature}`,
      source: sample.source,
    })),
    ...results.serverReady.map((sample) => ({
      label: `Server readiness pair ${sample.pair} ${sample.temperature}`,
      source: sample.source,
    })),
  ];
}

/** Primary samples whose source or working-tree diff differs from what the result captured. */
function sourceDriftFailures(results: MeasurementResults): string[] {
  const expectedSha = results.environment.sourceSha;
  const expectedDiff = results.environment.workingTreeDiffSha256;
  const expectedUntracked = results.environment.untrackedSha256 ?? null;
  return primarySamples(results)
    .filter(
      ({ source }) =>
        source.sourceSha !== expectedSha ||
        source.workingTreeDiffSha256 !== expectedDiff ||
        (source.untrackedSha256 ?? null) !== expectedUntracked,
    )
    .map(
      ({ label, source }) =>
        `${label} ran on source ${source.sourceSha} with diff ${source.workingTreeDiffSha256 ?? 'none'}; the result captured ${expectedSha} with diff ${expectedDiff ?? 'none'}.`,
    );
}

function measuredChildren(
  results: MeasurementResults,
): { label: string; child: ChildMeasurement }[] {
  return [
    ...results.prerequisites.map((sample) => ({ label: 'Prerequisite', child: sample.child })),
    ...results.staticExport.map((sample) => ({
      label: `Static export pair ${sample.pair} ${sample.temperature}`,
      child: sample.child,
    })),
    ...results.serverReady.map((sample) => ({
      label: `Server readiness pair ${sample.pair} ${sample.temperature}`,
      child: sample.child,
    })),
    ...results.playwright.map((sample) => ({
      label: `Playwright pair ${sample.pair} ${sample.temperature}`,
      child: sample.child,
    })),
    ...Object.entries(results.probes).map(([name, probe]) => ({
      label: `The ${name} probe`,
      child: probe.child,
    })),
  ];
}

/** Measured children with no successful process-tree reading: their peak is unknown, not zero. */
function blindTreeFailures(results: MeasurementResults): string[] {
  const blind = measuredChildren(results)
    .filter(({ child }) => child.tree.sampleCount === 0)
    .map(({ label }) => label);
  for (const sample of results.serverReady) {
    const label = `Server readiness pair ${sample.pair} ${sample.temperature} until ready`;
    if (sample.treeUntilReady.sampleCount === 0) blind.push(label);
  }
  return blind.map(
    (label) => `${label} has no successful process-tree reading; its peak is unknown, not 0 bytes.`,
  );
}

/** Failed process-table reads, reported for every measured child that had any. */
export function treeReadWarnings(results: MeasurementResults): string[] {
  return measuredChildren(results)
    .filter(({ child }) => (child.tree.failedReads ?? 0) > 0)
    .map(({ label, child }) => {
      const first = child.tree.failureMessages?.[0];
      return `${label}: ${child.tree.failedReads} process-tree reads failed${first === undefined ? '' : ` (first: ${first})`}.`;
    });
}

/** `kern.memorystatus_vm_pressure_level` for normal memory pressure. */
export const NORMAL_MEMORY_PRESSURE_LEVEL = 1;

/**
 * Primary memory observations that cannot be trusted: taken while memory pressure was above normal,
 * or with no pressure reading at all. Compressed idle pages make resident size incomparable across
 * pressure states, so `compare` refuses any result carrying one of these.
 */
export function memoryPressureFlags(results: MeasurementResults): string[] {
  const observations: { label: string; level: number | null | undefined }[] = [
    ...results.staticExport.map((sample) => ({
      label: `Static export pair ${sample.pair} ${sample.temperature}`,
      level: sample.child.tree.maximumPressureLevel,
    })),
    ...results.serverReady.map((sample) => ({
      label: `Server readiness pair ${sample.pair} ${sample.temperature} until ready`,
      level: sample.treeUntilReady.maximumPressureLevel,
    })),
  ];
  return observations.flatMap(({ label, level }) => {
    if (level === null || level === undefined) return [`${label} has no memory-pressure reading.`];
    return level > NORMAL_MEMORY_PRESSURE_LEVEL
      ? [
          `${label} ran under memory pressure level ${level} (normal is ${NORMAL_MEMORY_PRESSURE_LEVEL}).`,
        ]
      : [];
  });
}

/**
 * Primary samples whose observed processes outlived them. A surviving descendant can keep using
 * the host while the next sample runs, so results carrying one are not comparable.
 */
export function primarySurvivorFailures(results: MeasurementResults): string[] {
  return survivingPidFailures({ ...results, prerequisites: [], playwright: [], probes: {} });
}

/** Every measured child, probes included, whose observed processes outlived it. */
export function survivingPidFailures(results: MeasurementResults): string[] {
  return measuredChildren(results)
    .filter(({ child }) => child.survivingPids.length > 0)
    .map(({ label, child }) => `${label} left pids ${child.survivingPids.join(', ')} running.`);
}

/** Failures in the static-export and server-readiness samples, which feed the primary metrics. */
export function primaryMetricFailures(results: MeasurementResults): string[] {
  return runFailures({ ...results, playwright: [], probes: {} });
}

/** Samples that did not complete: a failed export or Playwright run, a readiness miss, a failed probe. */
export function runFailures(results: MeasurementResults): string[] {
  const failures: string[] = [];
  for (const sample of results.prerequisites) {
    if (sample.child.exitCode !== 0) {
      failures.push(
        `Prerequisite ${sample.child.command.join(' ')} exited ${sample.child.exitCode}.`,
      );
    }
  }
  for (const sample of results.staticExport) {
    if (sample.child.exitCode !== 0) {
      failures.push(
        `Static export pair ${sample.pair} ${sample.temperature} exited ${sample.child.exitCode}.`,
      );
    }
  }
  for (const sample of results.serverReady) {
    const label = `Server readiness pair ${sample.pair} ${sample.temperature}`;
    if (sample.readyOutcome !== 'ready') {
      failures.push(
        `${label}: ${sample.readyOutcome} (limit ${sample.readyDeadlineMilliseconds} ms).`,
      );
    } else if (sample.prebuildSummary === null) {
      // Readiness only counts when the eager prebuild finished every page bundle.
      failures.push(`${label} reported no prebuild summary.`);
    } else if (sample.prebuildSummary.succeeded !== sample.prebuildSummary.total) {
      failures.push(
        `${label} prebuilt ${sample.prebuildSummary.succeeded} of ${sample.prebuildSummary.total} page bundles.`,
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
  failures.push(...sourceDriftFailures(results), ...blindTreeFailures(results));
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
