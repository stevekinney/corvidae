import { describe, expect, it } from 'bun:test';

import {
  comparabilityProblems,
  observationsFromResults,
  RESULT_SCHEMA,
  runFailures,
  summarizePlaywrightReport,
  type MeasurementResults,
  type ServerReadySample,
  type StaticExportSample,
} from './measure-playground-results.ts';

describe('summarizePlaywrightReport', () => {
  it('sums every nested test result and keeps the reported totals', () => {
    expect(
      summarizePlaywrightReport({
        stats: { duration: 9000, expected: 3, unexpected: 0, flaky: 0, skipped: 1 },
        suites: [
          {
            specs: [{ tests: [{ results: [{ duration: 100 }] }] }],
            suites: [{ specs: [{ tests: [{ results: [{ duration: 200 }, { duration: 50 }] }] }] }],
          },
        ],
      }),
    ).toEqual({
      reportedDurationMilliseconds: 9000,
      expected: 3,
      unexpected: 0,
      flaky: 0,
      skipped: 1,
      testResults: 3,
      testExecutionMilliseconds: 350,
    });
  });
});

const tree = {
  intervalMilliseconds: 100,
  sampleCount: 1,
  skippedTicks: 0,
  peakResidentBytes: 0,
  peakProcessCount: 1,
  observedPids: [],
};

function child(wallMilliseconds: number, peakResidentBytes: number) {
  return {
    command: ['bun'],
    exitCode: 0,
    signalCode: null,
    wallMilliseconds,
    childMaxResidentBytes: peakResidentBytes,
    userCpuMicroseconds: null,
    systemCpuMicroseconds: null,
    tree: { ...tree, peakResidentBytes },
    survivingPids: [],
    logPath: 'log',
  };
}

const load = {
  capturedAt: '',
  uptime: '',
  loadAverages: { oneMinute: 1, fiveMinutes: 1, fifteenMinutes: 1 },
  logicalProcessors: 1,
};

const loadWait = { thresholdOneMinute: 3, waitedMilliseconds: 0, checks: 1, loadAtStart: load };

function exportSample(
  temperature: 'cold' | 'warm',
  wall: number,
  peak: number,
  dirty = false,
): StaticExportSample {
  return {
    pair: 1,
    temperature,
    loadWait,
    hostLoadBefore: load,
    hostLoadAfter: load,
    source: {
      sourceSha: 'sha',
      dirtyPaths: dirty ? ['x'] : [],
      untrackedPaths: [],
      workingTreeDiffSha256: null,
    },
    child: child(wall, peak),
    inventory: {
      fileCount: 0,
      totalBytes: 0,
      uniqueContentCount: 0,
      uniqueContentBytes: 0,
      groups: {},
    },
    routeCount: 2,
    exporterSummary: null,
  };
}

function serverSample(
  temperature: 'cold' | 'warm',
  ready: number,
  peak: number,
): ServerReadySample {
  return {
    pair: 1,
    temperature,
    loadWait,
    hostLoadBefore: load,
    hostLoadAfter: load,
    source: { sourceSha: 'sha', dirtyPaths: [], untrackedPaths: [], workingTreeDiffSha256: null },
    child: child(ready + 10, peak),
    spawnToReadyMilliseconds: ready,
    readyOutcome: 'ready',
    readyDeadlineMilliseconds: 300_000,
    treeUntilReady: { ...tree, peakResidentBytes: peak },
    prebuildSummary: null,
  };
}

function results(overrides: Partial<MeasurementResults>): MeasurementResults {
  return {
    schema: RESULT_SCHEMA,
    label: 'baseline',
    startedAt: '',
    finishedAt: '',
    environment: {
      sourceSha: 'sha',
      dirtyPaths: [],
      untrackedPaths: [],
      workingTreeDiffSha256: null,
      lockfileSha256: 'lock',
      versions: { bun: '1', svelte: '5', playwright: '1' },
      operatingSystem: { platform: 'darwin', release: '', architecture: 'arm64', cpuModel: '' },
      logicalProcessors: 1,
      totalMemoryBytes: 1,
      containerMemoryLimit: 'none',
    },
    routeInventory: ['/', '/page/button'],
    definitions: {},
    prerequisites: [],
    staticExport: [],
    serverReady: [],
    playwright: [],
    probes: {},
    ...overrides,
  };
}

describe('observationsFromResults', () => {
  it('pairs each primary metric per subject and temperature', () => {
    const baseline = results({
      staticExport: [exportSample('cold', 100, 1000), exportSample('warm', 90, 900)],
      serverReady: [serverSample('cold', 50, 500)],
    });
    const candidate = results({
      label: 'candidate',
      staticExport: [exportSample('cold', 80, 1100, true), exportSample('warm', 85, 950, true)],
      serverReady: [serverSample('cold', 40, 600)],
    });
    const keys = observationsFromResults(baseline, candidate).map(
      (observation) =>
        `${observation.metric}${observation.subject === undefined ? '' : `(${observation.subject})`}/${observation.temperature}`,
    );
    expect(keys).toEqual([
      'staticExportMilliseconds/cold',
      'serverSpawnToReadyMilliseconds/cold',
      'processTreePeakResidentBytes(static-export)/cold',
      'processTreePeakResidentBytes(server-until-ready)/cold',
      'staticExportMilliseconds/warm',
      'processTreePeakResidentBytes(static-export)/warm',
    ]);
  });
});

describe('comparabilityProblems', () => {
  it('accepts matching source, lockfile, and routes with a clean baseline', () => {
    const baseline = results({ staticExport: [exportSample('cold', 1, 1)] });
    const candidate = results({ staticExport: [exportSample('cold', 1, 1, true)] });
    expect(comparabilityProblems(baseline, candidate)).toEqual([]);
  });

  it('refuses different routes, a different source, and a dirty baseline', () => {
    const baseline = results({ staticExport: [exportSample('cold', 1, 1, true)] });
    const candidate = results({ routeInventory: ['/'] });
    candidate.environment = { ...candidate.environment, sourceSha: 'other' };
    expect(comparabilityProblems(baseline, candidate)).toEqual([
      'Source SHA differs: baseline sha, candidate other.',
      'Route inventories differ; the experiment must run on identical routes.',
      'A baseline sample ran against a dirty working tree.',
    ]);
  });
});

describe('runFailures', () => {
  it('reports a readiness miss, a failed export, and a failed probe', () => {
    const failed = exportSample('cold', 1, 1);
    failed.child = { ...failed.child, exitCode: 1 };
    const missed: ServerReadySample = {
      ...serverSample('warm', 1, 1),
      spawnToReadyMilliseconds: null,
      readyOutcome: 'deadline-exceeded',
    };
    const subject = results({
      staticExport: [failed],
      serverReady: [missed],
      probes: { rebuild: { loadWait, child: child(1, 1), result: null, error: 'See log.' } },
    });
    expect(runFailures(subject)).toEqual([
      'Static export pair 1 cold exited 1.',
      'Server readiness pair 1 warm: deadline-exceeded (limit 300000 ms).',
      'The rebuild probe failed. See log.',
    ]);
  });

  it('makes results with a failure incomparable', () => {
    const missed: ServerReadySample = {
      ...serverSample('cold', 1, 1),
      spawnToReadyMilliseconds: null,
      readyOutcome: 'exited',
    };
    expect(comparabilityProblems(results({ serverReady: [missed] }), results({}))).toEqual([
      'baseline: Server readiness pair 1 cold: exited (limit 300000 ms).',
    ]);
  });
});
