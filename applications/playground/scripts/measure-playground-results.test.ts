import { describe, expect, it } from 'bun:test';

import {
  comparabilityProblems,
  observationsFromResults,
  RESULT_SCHEMA,
  runFailures,
  summarizePlaywrightReport,
  survivingPidFailures,
  treeReadWarnings,
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
      playgroundEnvironment: {},
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

/** Three cold and three warm samples for every primary subject, as the protocol records. */
function complete(overrides: Partial<MeasurementResults> = {}, dirty = false): MeasurementResults {
  const staticExport: StaticExportSample[] = [];
  const serverReady: ServerReadySample[] = [];
  for (const temperature of ['cold', 'warm'] as const) {
    for (let pair = 1; pair <= 3; pair += 1) {
      staticExport.push({ ...exportSample(temperature, 100, 1000, dirty), pair });
      serverReady.push({ ...serverSample(temperature, 50, 500), pair });
    }
  }
  return results({ staticExport, serverReady, ...overrides });
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
  it('accepts matching source, lockfile, routes, environment, and coverage with a clean baseline', () => {
    expect(comparabilityProblems(complete(), complete({ label: 'candidate' }, true))).toEqual([]);
  });

  it('refuses different routes, a different source, and a dirty baseline', () => {
    const baseline = results({ staticExport: [exportSample('cold', 1, 1, true)] });
    const candidate = results({ routeInventory: ['/'] });
    candidate.environment = { ...candidate.environment, sourceSha: 'other' };
    const problems = comparabilityProblems(baseline, candidate);
    expect(problems).toContain('Source SHA differs: baseline sha, candidate other.');
    expect(problems).toContain(
      'Route inventories differ; the experiment must run on identical routes.',
    );
    expect(problems).toContain('A baseline sample ran against a dirty working tree.');
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
    expect(comparabilityProblems(results({ serverReady: [missed] }), results({}))).toContain(
      'baseline: Server readiness pair 1 cold: exited (limit 300000 ms).',
    );
  });
});

describe('comparability scope', () => {
  it('ignores Playwright and probe failures, which feed no primary metric', () => {
    const playwrightFailure = {
      ...exportSample('cold', 1, 1),
      child: { ...child(1, 1), exitCode: 1 },
      report: null,
    };
    const subject = complete({
      playwright: [playwrightFailure],
      probes: { navigation: { loadWait, child: child(1, 1), result: null, error: 'See log.' } },
    });
    expect(runFailures(subject)).toHaveLength(2);
    expect(comparabilityProblems(subject, complete())).toEqual([]);
  });
});

describe('harness integrity (PR #222)', () => {
  it('fails a run and refuses a comparison when the install prerequisite exits nonzero (4273630227)', () => {
    const failedInstall = complete({
      prerequisites: [
        {
          pair: 1,
          loadWait,
          hostLoadBefore: load,
          hostLoadAfter: load,
          source: {
            sourceSha: 'sha',
            dirtyPaths: [],
            untrackedPaths: [],
            workingTreeDiffSha256: null,
          },
          child: { ...child(1, 1), command: ['bun', 'install', '--frozen-lockfile'], exitCode: 1 },
        },
      ],
    });
    expect(runFailures(failedInstall)).toContain(
      'Prerequisite bun install --frozen-lockfile exited 1.',
    );
    expect(comparabilityProblems(failedInstall, complete())).toContain(
      'baseline: Prerequisite bun install --frozen-lockfile exited 1.',
    );
  });

  it('fails a result whose primary samples ran on a different source or diff than it captured (4273630230)', () => {
    const drifted = complete();
    drifted.serverReady[2] = {
      ...drifted.serverReady[2]!,
      source: { ...drifted.serverReady[2]!.source, workingTreeDiffSha256: 'patch' },
    };
    expect(runFailures(drifted)).toContain(
      'Server readiness pair 3 cold ran on source sha with diff patch; the result captured sha with diff none.',
    );
    expect(
      comparabilityProblems(complete(), drifted).some((problem) =>
        problem.startsWith('candidate: Server readiness pair 3 cold ran on'),
      ),
    ).toBe(true);
  });

  it('accepts a candidate whose every sample carries its own patch digest (4273630230)', () => {
    const patched = complete({ label: 'candidate' });
    patched.environment = { ...patched.environment, workingTreeDiffSha256: 'patch' };
    for (const sample of [...patched.staticExport, ...patched.serverReady]) {
      sample.source = { ...sample.source, dirtyPaths: ['x'], workingTreeDiffSha256: 'patch' };
    }
    expect(comparabilityProblems(complete(), patched)).toEqual([]);
  });

  it('refuses results from different environments (4273630235)', () => {
    const elsewhere = complete();
    elsewhere.environment = {
      ...elsewhere.environment,
      versions: { ...elsewhere.environment.versions, bun: '2' },
      operatingSystem: { platform: 'linux', release: '6', architecture: 'x64', cpuModel: 'Other' },
      logicalProcessors: 4,
      totalMemoryBytes: 2,
      containerMemoryLimit: '8 GB',
    };
    const problems = comparabilityProblems(complete(), elsewhere);
    for (const field of [
      'Bun version',
      'platform',
      'OS release',
      'architecture',
      'CPU model',
      'logical processors',
      'total memory',
      'container memory limit',
    ]) {
      expect(
        problems.some((problem) => problem.startsWith(`Environment differs in ${field}:`)),
      ).toBe(true);
    }
  });

  it('refuses a comparison missing a temperature, with unequal counts, or below three samples (4273630238)', () => {
    const coldOnly = complete();
    coldOnly.staticExport = coldOnly.staticExport.filter((sample) => sample.temperature === 'cold');
    expect(comparabilityProblems(coldOnly, complete())).toContain(
      'staticExportMilliseconds/warm: baseline has 0 samples and candidate 3; each side needs the same count, at least 3.',
    );
    const smoke = complete();
    smoke.serverReady = smoke.serverReady.filter((sample) => sample.pair === 1);
    expect(comparabilityProblems(smoke, smoke)).toContain(
      'serverSpawnToReadyMilliseconds/cold: baseline has 1 samples and candidate 1; each side needs the same count, at least 3.',
    );
  });

  it('includes probe children in the surviving-process check (4273630247)', () => {
    const subject = complete({
      probes: {
        rebuild: { loadWait, child: { ...child(1, 1), survivingPids: [4242] }, result: {} },
      },
    });
    expect(survivingPidFailures(subject)).toEqual(['The rebuild probe left pids 4242 running.']);
  });

  it('validates both schemas before any other rule (4273630254)', () => {
    const foreign = { schema: 'something-else/1' } as unknown as MeasurementResults;
    expect(comparabilityProblems(foreign, complete())).toEqual([
      `baseline schema is "something-else/1"; expected "${RESULT_SCHEMA}".`,
    ]);
  });

  it('fails a measured sample with no successful process-tree reading and reports failed reads (4273630265)', () => {
    const blind = complete();
    blind.staticExport[0] = {
      ...blind.staticExport[0]!,
      child: {
        ...blind.staticExport[0]!.child,
        tree: { ...tree, sampleCount: 0, failedReads: 4, failureMessages: ['ps: busy'] },
      },
    };
    expect(runFailures(blind)).toContain(
      'Static export pair 1 cold has no successful process-tree reading; its peak is unknown, not 0 bytes.',
    );
    expect(treeReadWarnings(blind)).toEqual([
      'Static export pair 1 cold: 4 process-tree reads failed (first: ps: busy).',
    ]);
  });
});
