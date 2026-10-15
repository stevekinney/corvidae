import { describe, expect, it } from 'bun:test';

import { recordedChildEnvironment } from './measure-playground-environment.ts';

import {
  comparabilityProblems,
  memoryPressureFlags,
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
  pressureReadings: 1,
  maximumPressureLevel: 1,
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
    exporterSummary: { renderedFiles: 10, sidebarComponents: 181, reportedSeconds: 1 },
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
    prebuildSummary: { succeeded: 181, total: 181, selfReportedPeakResidentMegabytes: 1 },
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
      childEnvironment: recordedChildEnvironment(),
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
  const result = results({ staticExport, serverReady, ...overrides });
  if (dirty) {
    result.environment = { ...result.environment, workingTreeDiffSha256: 'patch' };
    for (const sample of [...result.staticExport, ...result.serverReady]) {
      sample.source = { ...sample.source, workingTreeDiffSha256: 'patch' };
    }
  }
  return result;
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
    expect(comparabilityProblems(subject, complete({ label: 'candidate' }, true))).toEqual([]);
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

describe('harness integrity, second review (PR #222)', () => {
  it('refuses results whose measured children ran with a different environment (4274040392)', () => {
    const candidate = complete({ label: 'candidate' }, true);
    candidate.environment = {
      ...candidate.environment,
      childEnvironment: { ...recordedChildEnvironment(), NODE_ENV: 'production' },
    };
    expect(
      comparabilityProblems(complete(), candidate).some((problem) =>
        problem.startsWith(
          'candidate: measured children did not run with the normalized environment',
        ),
      ),
    ).toBe(true);
  });

  it("refuses a candidate with no working-tree change, or the baseline's own (4274040412)", () => {
    expect(comparabilityProblems(complete(), complete({ label: 'candidate' }))).toContain(
      'The candidate has no working-tree change of its own, so there is nothing to select.',
    );
    const baseline = complete({}, true);
    expect(comparabilityProblems(baseline, complete({ label: 'candidate' }, true))).toContain(
      'The candidate has no working-tree change of its own, so there is nothing to select.',
    );
  });

  it('refuses a candidate that changes the measurement harness or its dependencies (4274040420)', () => {
    const candidate = complete({ label: 'candidate' }, true);
    candidate.staticExport[0] = {
      ...candidate.staticExport[0]!,
      source: {
        ...candidate.staticExport[0]!.source,
        dirtyPaths: ['applications/playground/scripts/measure-playground-results.ts'],
        untrackedPaths: ['applications/playground/src/playground-paths.ts'],
      },
    };
    const problems = comparabilityProblems(complete(), candidate);
    expect(problems).toContain(
      'The candidate changes the measurement harness: applications/playground/scripts/measure-playground-results.ts, applications/playground/src/playground-paths.ts.',
    );
  });

  it('refuses a baseline with untracked files, which can change what is built (4274040383)', () => {
    const baseline = complete();
    baseline.staticExport[0] = {
      ...baseline.staticExport[0]!,
      source: {
        ...baseline.staticExport[0]!.source,
        untrackedPaths: ['applications/playground/src/examples/button/new.example.svelte'],
      },
    };
    expect(comparabilityProblems(baseline, complete({ label: 'candidate' }, true))).toContain(
      'A baseline sample ran with untracked files in the working tree.',
    );
  });

  it('fails a sample whose untracked-content digest differs from its result (4274040383)', () => {
    const drifted = complete();
    drifted.staticExport[1] = {
      ...drifted.staticExport[1]!,
      source: { ...drifted.staticExport[1]!.source, untrackedSha256: 'added-later' },
    };
    expect(
      runFailures(drifted).some((failure) =>
        failure.startsWith('Static export pair 2 cold ran on source'),
      ),
    ).toBe(true);
  });

  it('counts a readiness sample only when every page bundle prebuilt (4274040417)', () => {
    const subject = complete();
    subject.serverReady[0] = { ...subject.serverReady[0]!, prebuildSummary: null };
    subject.serverReady[1] = {
      ...subject.serverReady[1]!,
      prebuildSummary: { succeeded: 180, total: 181, selfReportedPeakResidentMegabytes: 1 },
    };
    const failures = runFailures(subject);
    expect(failures).toContain('Server readiness pair 1 cold reported no prebuild summary.');
    expect(failures).toContain('Server readiness pair 2 cold prebuilt 180 of 181 page bundles.');
  });
});

describe('harness integrity, third review (PR #222)', () => {
  it('refuses a candidate that prebuilds a narrower workload than the baseline (4275577710)', () => {
    const candidate = complete({ label: 'candidate' }, true);
    for (const sample of candidate.serverReady) {
      sample.prebuildSummary = { succeeded: 12, total: 12, selfReportedPeakResidentMegabytes: 1 };
    }
    const problems = comparabilityProblems(complete(), candidate);
    expect(problems).toContain(
      'Readiness samples prebuilt different workloads: 12, 181 page bundles.',
    );
  });

  it('refuses a prebuild that does not cover the exported sidebar components (4275577710)', () => {
    const baseline = complete();
    const candidate = complete({ label: 'candidate' }, true);
    for (const sample of [...baseline.serverReady, ...candidate.serverReady]) {
      sample.prebuildSummary = { succeeded: 150, total: 150, selfReportedPeakResidentMegabytes: 1 };
    }
    expect(comparabilityProblems(baseline, candidate)).toContain(
      'Readiness samples prebuilt 150 page bundles, but the static exports document 181 sidebar components.',
    );
  });

  it('refuses results without an exporter component count to check the prebuild against (4275577710)', () => {
    const baseline = complete();
    for (const sample of baseline.staticExport) sample.exporterSummary = null;
    expect(comparabilityProblems(baseline, complete({ label: 'candidate' }, true))).toContain(
      'Static exports do not report one sidebar component count to check the prebuild workload against.',
    );
  });

  it('refuses results resolved against a different Svelte version (4275577716)', () => {
    const candidate = complete({ label: 'candidate' }, true);
    candidate.environment = {
      ...candidate.environment,
      versions: { ...candidate.environment.versions, svelte: '6' },
    };
    expect(comparabilityProblems(complete(), candidate)).toContain(
      'Environment differs in Svelte version: baseline "5", candidate "6".',
    );
  });
});

describe('schema /2 and the normalized child environment (CIN-588 harness fix 2)', () => {
  it('names schema version 2', () => {
    expect(RESULT_SCHEMA).toBe('cin-585-playground-measurements/2');
  });

  it('refuses a version 1 result', () => {
    const old = {
      ...complete(),
      schema: 'cin-585-playground-measurements/1',
    } as unknown as MeasurementResults;
    expect(comparabilityProblems(old, complete({ label: 'candidate' }, true))).toEqual([
      `baseline schema is "cin-585-playground-measurements/1"; expected "${RESULT_SCHEMA}".`,
    ]);
  });

  it('refuses a result that records no child environment', () => {
    const baseline = complete();
    const { childEnvironment: _omitted, ...withoutChildEnvironment } = baseline.environment;
    baseline.environment = withoutChildEnvironment as typeof baseline.environment;
    expect(
      comparabilityProblems(baseline, complete({ label: 'candidate' }, true)).some((problem) =>
        problem.startsWith(
          'baseline: measured children did not run with the normalized environment',
        ),
      ),
    ).toBe(true);
  });
});

describe('survivor-aware comparison (CIN-588 harness fix 3)', () => {
  it('refuses results whose primary samples left processes running', () => {
    const baseline = complete();
    baseline.staticExport[0] = {
      ...baseline.staticExport[0]!,
      child: { ...baseline.staticExport[0]!.child, survivingPids: [4242] },
    };
    const candidate = complete({ label: 'candidate' }, true);
    candidate.serverReady[3] = {
      ...candidate.serverReady[3]!,
      child: { ...candidate.serverReady[3]!.child, survivingPids: [5151] },
    };
    const problems = comparabilityProblems(baseline, candidate);
    expect(problems).toContain('baseline: Static export pair 1 cold left pids 4242 running.');
    expect(problems).toContain('candidate: Server readiness pair 1 warm left pids 5151 running.');
  });

  it('does not refuse for a survivor outside the primary samples', () => {
    const baseline = complete({
      probes: { rebuild: { loadWait, child: { ...child(1, 1), survivingPids: [7] }, result: {} } },
    });
    expect(comparabilityProblems(baseline, complete({ label: 'candidate' }, true))).toEqual([]);
  });
});

describe('memory-pressure validity (CIN-588 harness fix 5)', () => {
  it('flags a primary memory observation taken above normal pressure and refuses the comparison', () => {
    const baseline = complete();
    baseline.staticExport[4] = {
      ...baseline.staticExport[4]!,
      child: {
        ...baseline.staticExport[4]!.child,
        tree: { ...baseline.staticExport[4]!.child.tree, maximumPressureLevel: 2 },
      },
    };
    expect(memoryPressureFlags(baseline)).toEqual([
      'Static export pair 2 warm ran under memory pressure level 2 (normal is 1).',
    ]);
    expect(comparabilityProblems(baseline, complete({ label: 'candidate' }, true))).toContain(
      'baseline: Static export pair 2 warm ran under memory pressure level 2 (normal is 1).',
    );
  });

  it('flags a server observation with no pressure reading until ready', () => {
    const candidate = complete({ label: 'candidate' }, true);
    candidate.serverReady[0] = {
      ...candidate.serverReady[0]!,
      treeUntilReady: { ...candidate.serverReady[0]!.treeUntilReady, maximumPressureLevel: null },
    };
    expect(comparabilityProblems(complete(), candidate)).toContain(
      'candidate: Server readiness pair 1 cold until ready has no memory-pressure reading.',
    );
  });
});

describe('a readiness slower than the old cutoff (CIN-588, owner-approved 2026-10-15)', () => {
  it('records a 450 s readiness inside the 900 s cutoff instead of failing it', () => {
    const slow = complete();
    slow.serverReady[0] = {
      ...slow.serverReady[0]!,
      spawnToReadyMilliseconds: 450_000,
      readyOutcome: 'ready',
      readyDeadlineMilliseconds: 900_000,
    };
    expect(runFailures(slow)).toEqual([]);
    expect(comparabilityProblems(slow, complete({ label: 'candidate' }, true))).toEqual([]);
  });
});
