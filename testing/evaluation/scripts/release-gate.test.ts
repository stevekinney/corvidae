import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { BunSQLiteStorage, textValueStore } from '@lostgradient/weft';

import { GATE_RECORD_SCHEMA_VERSION, type GateDecisionRecord } from '../src/gate';
import { createEvaluationHistory, type HistoricalRecord } from '../src/history';
import type { ReleaseGateReport } from '../src/release-gate';
import { runReleaseGate } from '../src/release-gate';
import {
  capitalThresholdAt,
  FIXTURE_GATE_ID,
  fixtureGateFile,
  GATE_ACTOR,
  type GateFile,
  OVERRIDE_AUTHORITY,
  writeGates,
} from '../src/release-gate.test-support';
import {
  DEFAULT_GATES_DIRECTORY,
  gitHeadRevision,
  gitRevisionDistance,
  runReleaseGateCommand,
} from './release-gate';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..');

let directory: string;
let storePath: string;
let gateDirectories = 0;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'release-gate-command-'));
  storePath = join(directory, 'history.sqlite');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function gatesDirectory(gates: Readonly<Record<string, GateFile>>): Promise<string> {
  gateDirectories += 1;
  return writeGates(join(directory, `gates-${gateDirectories}`), gates);
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The documented `--filter` form, from the repository root, in a separate `bun` process. */
async function spawnFilteredGate(...args: string[]): Promise<CommandResult> {
  const child = spawnWithHangGuard(
    [process.execPath, 'run', '--filter=@lostgradient/evaluation', 'release-gate', '--', ...args],
    { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runInProcess(
  args: readonly string[],
  options: Parameters<typeof runReleaseGateCommand>[1] = {},
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runReleaseGateCommand(args, {
    // The checked-out revision is incidental to these tests, so it is read once at module scope and
    // injected; the test that proves the command reads git by default runs at module scope too.
    sourceRevision: checkedOutHead,
    revisionDistance: () => undefined,
    ...options,
    output: {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    },
  });
  return { exitCode, stdout, stderr };
}

async function gateDecisions(): Promise<HistoricalRecord<GateDecisionRecord>[]> {
  const store = textValueStore(new BunSQLiteStorage(storePath));
  try {
    const records = await createEvaluationHistory(store).list();
    return records.filter(
      (entry): entry is HistoricalRecord<GateDecisionRecord> =>
        entry.record.kind === 'gate-decision',
    );
  } finally {
    await store.close();
  }
}

/** Stdout parses as exactly one report whose decision matches the exit code; stderr carries the diagnostics. */
function expectReport(
  result: CommandResult,
  exitCode: number,
  decision: string,
): ReleaseGateReport {
  expect(result.exitCode).toBe(exitCode);
  const report = JSON.parse(result.stdout) as ReleaseGateReport;
  expect(report).toMatchObject({
    kind: 'release-gate-report',
    schemaVersion: 1,
    decision,
    exitCode,
  });
  expect(result.stdout).not.toContain('release gate:');
  expect(result.stderr).toContain(`release gate: ${decision} (exit ${exitCode})`);
  return report;
}

describe('runReleaseGateCommand (in process)', () => {
  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each(['baseline', 'sampleSize'])(
    'exits 64 for a test gate file missing %s',
    async (field) => {
      const gate = fixtureGateFile();
      delete gate[field];
      const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: gate });

      const result = await runInProcess([
        '--gate',
        FIXTURE_GATE_ID,
        '--gates-dir',
        gates,
        '--store',
        storePath,
      ]);

      const report = expectReport(result, 64, 'configuration-error');
      expect(report.recordId).toBeNull();
      expect(report.gates).toEqual([
        expect.objectContaining({
          decision: 'configuration-error',
          issues: [
            `gate: ${field}: Invalid input: expected ${field === 'baseline' ? 'object' : 'number'}, received undefined`,
          ],
        }),
      ]);
      expect(result.stderr).toContain(`gate: ${field}: Invalid input`);
    },
  );

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each<[string, GateFile, number, GateDecisionRecord['decision']]>([
    ['the passing script', fixtureGateFile('passing'), 0, 'pass'],
    ['the regressing script', fixtureGateFile('regressing'), 1, 'regression'],
    ['a scripted judge that throws', fixtureGateFile('judge-throws'), 2, 'infrastructure-failure'],
    [
      'a sample size above the recorded trials',
      fixtureGateFile('passing', { sampleSize: 7 }),
      3,
      'insufficient-evidence',
    ],
    ['an uncalibrated judge', fixtureGateFile('uncalibrated'), 3, 'insufficient-evidence'],
  ])('fixture-regression with %s exits %d', async (_label, gate, exitCode, decision) => {
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: gate });

    const result = await runInProcess([
      '--gate',
      FIXTURE_GATE_ID,
      '--gates-dir',
      gates,
      '--store',
      storePath,
    ]);

    const report = expectReport(result, exitCode, decision);
    const [decided] = await gateDecisions();
    expect(report.recordId).toBe(decided!.record.id);
    expect(decided!.record.decision).toBe(decision);
    expect(result.stderr).toContain(
      `${FIXTURE_GATE_ID}: ${decision} (exit ${exitCode}), recorded ${decided!.record.id}`,
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('fixture-regression with an expired baseline exits 3', async () => {
    // A passing decision recorded a year before this run.
    const store = textValueStore(new BunSQLiteStorage(storePath));
    try {
      await runReleaseGate({
        gatesDirectory: await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile() }),
        gateId: FIXTURE_GATE_ID,
        history: createEvaluationHistory(store),
        actor: GATE_ACTOR,
        now: () => Date.now() - 365 * 86_400_000,
      });
    } finally {
      await store.close();
    }
    const gates = await gatesDirectory({
      [FIXTURE_GATE_ID]: fixtureGateFile('passing', {
        baseline: { kind: 'latest-passing-decision' },
        expiry: { maximumAgeMs: 86_400_000 },
      }),
    });

    const result = await runInProcess([
      '--gate',
      FIXTURE_GATE_ID,
      '--gates-dir',
      gates,
      '--store',
      storePath,
    ]);

    const report = expectReport(result, 3, 'insufficient-evidence');
    expect(report.gates[0]).toMatchObject({
      findings: { insufficientEvidence: [expect.objectContaining({ reason: 'baseline-expired' })] },
    });
    expect(result.stderr).toContain('insufficient evidence (baseline-expired)');
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('every run appends exactly one gate decision and never changes an earlier one', async () => {
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile() });
    const args = ['--gate', FIXTURE_GATE_ID, '--gates-dir', gates, '--store', storePath];

    const firstRun = await runInProcess(args);
    expect(firstRun.exitCode).toBe(0);
    const [first] = await gateDecisions();
    const secondRun = await runInProcess(args);
    expect(secondRun.exitCode).toBe(0);
    const after = await gateDecisions();

    expect(after).toHaveLength(2);
    expect(after.find((entry) => entry.record.id === first!.record.id)).toEqual(first);
  });
});

// The real process is the behavior under test (the documented invocation, its stdout, stderr and
// exit code), so it runs once here at module scope to stay off the per-test clock.
const spawnedFilteredGate = await (async () => {
  const spawnDirectory = await mkdtemp(join(tmpdir(), 'release-gate-command-spawn-'));
  try {
    const gates = await writeGates(join(spawnDirectory, 'gates'), {
      [FIXTURE_GATE_ID]: fixtureGateFile('passing'),
    });
    return await spawnFilteredGate(
      '--gates-dir',
      gates,
      '--store',
      join(spawnDirectory, 'history.sqlite'),
    );
  } finally {
    await rm(spawnDirectory, { recursive: true, force: true });
  }
})();

/**
 * The one test that boots a real `bun` process: the documented
 * `bun run --filter=@lostgradient/evaluation release-gate` invocation, from the
 * repository root, is wired to the entry point, and its stdout, stderr and exit
 * code carry the command's result. Every exit code is asserted in process, so
 * nothing else in this package pays for a spawn inside the per-test budget.
 */
describe('release-gate (spawned bun process, --filter form)', () => {
  test('exits 0 for a passing gate set through the documented --filter invocation', () => {
    const result = spawnedFilteredGate;

    // The filter form prefixes every line with the workspace and script names and
    // does not keep the two streams apart, so the report and the verdict line are
    // looked for in both.
    const output = result.stdout + result.stderr;
    expect(result.exitCode).toBe(0);
    expect(output).toContain('"kind": "release-gate-report"');
    expect(output).toContain('release gate: pass (exit 0)');
  });
});

const OTHER_REVISION = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';

// This scenario exists to prove the command reads git when nothing is injected, so its whole run
// happens here at module scope to stay off the per-test clock. It borrows the shared directory and
// store variables, which the hooks above replace before each test.
const defaultRevisionRecords = await (async () => {
  directory = await mkdtemp(join(tmpdir(), 'release-gate-command-default-revision-'));
  storePath = join(directory, 'history.sqlite');
  try {
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile() });
    const silent = { stdout: { write: () => 0 }, stderr: { write: () => 0 } };
    await runReleaseGateCommand(['--gates-dir', gates, '--store', storePath], { output: silent });
    await runReleaseGateCommand(['--gates-dir', gates, '--store', storePath], {
      output: silent,
      sourceRevision: OTHER_REVISION,
    });
    const decisions = await gateDecisions();
    return new Set(decisions.map((entry) => entry.record.sourceRevision));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

describe('runReleaseGateCommand', () => {
  test('defaults to the package’s committed gates directory', () => {
    expect(DEFAULT_GATES_DIRECTORY).toBe(join(PACKAGE_DIRECTORY, 'gates'));
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('runs every gate in the directory and exits with the most severe code', async () => {
    const gates = await gatesDirectory({
      alpha: fixtureGateFile('passing'),
      beta: fixtureGateFile('regressing'),
      gamma: fixtureGateFile('passing', { sampleSize: 0 }),
    });
    const result = await runInProcess(['--gates-dir', gates, '--store', storePath]);
    const report = expectReport(result, 64, 'configuration-error');
    expect(report.recordId).toBeNull();
    expect(report.gates.map((gate) => [gate.gateId, gate.exitCode])).toEqual([
      ['alpha', 0],
      ['beta', 1],
      ['gamma', 64],
    ]);
    expect(result.stderr).toContain('gamma: configuration-error (exit 64)\n  gate: sampleSize:');
    expect(result.stderr).toContain(
      '  regression: names-the-capital passFraction 1 -> 0.5 (hard, at most -0.1)',
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('names the predeclared improvement a run fell short of', async () => {
    const gates = await gatesDirectory({
      [FIXTURE_GATE_ID]: fixtureGateFile('passing', {
        regressionThresholds: [
          {
            criterion: 'names-the-capital',
            metric: 'passFraction',
            minimumIncrease: 0.5,
            severity: 'overridable',
          },
        ],
      }),
    });
    const result = await runInProcess(['--gates-dir', gates, '--store', storePath]);
    const report = expectReport(result, 1, 'regression');
    expect(report.gates[0]).toMatchObject({
      findings: { regressions: [{ criterion: 'names-the-capital', minimumIncrease: 0.5 }] },
    });
    expect(result.stderr).toContain(
      '  regression: names-the-capital passFraction 1 -> 1 (overridable, at least +0.5)',
    );
    expect(result.stderr).not.toContain('undefined');
  });

  const overridableCapital = capitalThresholdAt('overridable');
  const hardCapital = capitalThresholdAt('hard');

  /**
   * [label, thresholds of the overridden run, thresholds of the next run,
   * actor of the overridden run, override fields, the reason the next run
   * reports the override rejected — `null` when it covers nothing to reject].
   */
  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each<[string, GateFile, GateFile, string, Record<string, unknown>, string | null]>([
    [
      'by a principal other than the override authority',
      overridableCapital,
      overridableCapital,
      GATE_ACTOR,
      { actor: 'someone-else' },
      'not-override-authority',
    ],
    [
      'by the decision’s own actor',
      overridableCapital,
      overridableCapital,
      OVERRIDE_AUTHORITY,
      {},
      'decision-actor',
    ],
    [
      'past its expiry',
      overridableCapital,
      overridableCapital,
      GATE_ACTOR,
      { recordedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z' },
      'expired',
    ],
    [
      'of a regression the gate has since made hard',
      overridableCapital,
      hardCapital,
      GATE_ACTOR,
      {},
      'hard-regression',
    ],
    ['of a decision whose only regression is hard', hardCapital, hardCapital, GATE_ACTOR, {}, null],
  ])(
    'still exits 1 after an override %s',
    async (_label, before, after, actor, changes, reason) => {
      const args = async (thresholds: GateFile) => [
        '--gate',
        FIXTURE_GATE_ID,
        '--gates-dir',
        await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile('regressing', thresholds) }),
        '--store',
        storePath,
      ];
      const firstRun = await runInProcess([...(await args(before)), '--actor', actor]);
      const first = JSON.parse(firstRun.stdout) as ReleaseGateReport;
      const store = textValueStore(new BunSQLiteStorage(storePath));
      try {
        await createEvaluationHistory(store).append({
          kind: 'gate-override',
          schemaVersion: 1,
          id: 'override-under-test',
          recordedAt: new Date().toISOString(),
          gateId: FIXTURE_GATE_ID,
          gateDecisionId: first.recordId!,
          actor: OVERRIDE_AUTHORITY,
          reason: 'Known fixture change.',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          permanentBaselineChange: false,
          evidence: ['https://example.test/review/1'],
          ...changes,
        });
      } finally {
        await store.close();
      }

      const next = await runInProcess(await args(after));

      const report = expectReport(next, 1, 'regression');
      expect(report.gates[0]).toMatchObject({
        overrideIds: [],
        rejectedOverrides:
          reason === null
            ? []
            : [
                {
                  id: 'override-under-test',
                  criterion: 'names-the-capital',
                  metric: 'passFraction',
                  reason,
                },
              ],
      });
    },
  );

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('describes overrides, infrastructure failures, and a gate-decision baseline on stderr', async () => {
    const overridable = fixtureGateFile('regressing', capitalThresholdAt('overridable'));
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: overridable });
    const args = ['--gate', FIXTURE_GATE_ID, '--gates-dir', gates, '--store', storePath];
    const firstRun = await runInProcess(args);
    const first = JSON.parse(firstRun.stdout) as ReleaseGateReport;
    const store = textValueStore(new BunSQLiteStorage(storePath));
    try {
      const history = createEvaluationHistory(store);
      const base = {
        kind: 'gate-override' as const,
        schemaVersion: GATE_RECORD_SCHEMA_VERSION as 1,
        recordedAt: new Date().toISOString(),
        gateId: FIXTURE_GATE_ID,
        gateDecisionId: first.recordId!,
        reason: 'Known fixture change.',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        permanentBaselineChange: false,
        evidence: ['https://example.test/review/1'],
      };
      await history.append({ ...base, id: 'override-valid', actor: OVERRIDE_AUTHORITY });
      await history.append({ ...base, id: 'override-unauthorized', actor: 'someone-else' });
    } finally {
      await store.close();
    }

    const overridden = await runInProcess(args);
    const report = expectReport(overridden, 0, 'pass');
    expect(report.gates[0]).toMatchObject({ overrideIds: ['override-valid'] });
    expect(overridden.stderr).toContain(', overridden by override-valid)');
    expect(overridden.stderr).toContain(
      '  override rejected: override-unauthorized for names-the-capital passFraction (not-override-authority)',
    );

    const failing = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile('judge-throws') });
    const infrastructure = await runInProcess([
      '--gate',
      FIXTURE_GATE_ID,
      '--gates-dir',
      failing,
      '--store',
      storePath,
    ]);
    expect(infrastructure.stderr).toContain(
      '  infrastructure failure (evaluator-infrastructure-failure): Case 1',
    );

    const latest = await gatesDirectory({
      [FIXTURE_GATE_ID]: fixtureGateFile('passing', {
        baseline: { kind: 'latest-passing-decision' },
      }),
    });
    const latestArgs = ['--gate', FIXTURE_GATE_ID, '--gates-dir', latest, '--store', storePath];
    // A pass that needed an override never becomes the baseline.
    const unbased = await runInProcess(latestArgs);
    expectReport(unbased, 3, 'insufficient-evidence');
    expect(unbased.stderr).toContain('  insufficient evidence (baseline-missing): ');

    const passing = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile() });
    const clean = await runInProcess([
      '--gate',
      FIXTURE_GATE_ID,
      '--gates-dir',
      passing,
      '--store',
      storePath,
    ]);
    const rebased = await runInProcess(latestArgs);
    expect(rebased.stderr).toContain(
      `  baseline: gate-decision ${JSON.parse(clean.stdout).recordId}`,
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each([
    ['an unknown option', ['--force']],
    ['a positional argument', ['fixture-regression']],
    ['--gate without an id', ['--gate']],
    ['an empty actor', ['--actor', '']],
  ])('exits 64 with a report and usage for %s', async (_label, args) => {
    const result = await runInProcess([...args, '--store', storePath]);
    const report = expectReport(result, 64, 'configuration-error');
    expect(report.gates).toEqual([]);
    expect(result.stderr).toContain('Usage: bun run --cwd testing/evaluation release-gate');
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('exits 64 when the gates directory is missing or holds no gates', async () => {
    const missing = await runInProcess([
      '--gates-dir',
      join(directory, 'absent'),
      '--store',
      storePath,
    ]);
    expectReport(missing, 64, 'configuration-error');
    expect(missing.stderr).toContain('Cannot read the gates directory');

    const empty = join(directory, 'empty');
    await mkdir(empty);
    const none = await runInProcess(['--gates-dir', empty, '--store', storePath]);
    expectReport(none, 64, 'configuration-error');
    expect(none.stderr).toContain(`No gate files in ${empty}`);
  });

  test('records the repository revision it ran at, unless told another', () => {
    expect(defaultRevisionRecords).toEqual(new Set([checkedOutHead, OTHER_REVISION]));
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('runs as the current user unless --actor names someone', async () => {
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile() });
    await runInProcess(['--gates-dir', gates, '--store', storePath]);
    await runInProcess(['--gates-dir', gates, '--store', storePath, '--actor', 'agent-7']);
    const decisions = await gateDecisions();
    expect(decisions.map((entry) => entry.record.actor).toSorted()).toEqual(
      ['agent-7', userInfo().username].toSorted(),
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('keeps the most severe outcome when the machinery fails after earlier gates ran', async () => {
    const gates = await gatesDirectory({
      alpha: fixtureGateFile('passing', { sampleSize: 0 }),
      beta: fixtureGateFile('passing'),
      gamma: fixtureGateFile('regressing'),
    });
    let ids = 0;
    const failOnSecondRecord = (gateId: string) => {
      ids += 1;
      if (ids === 2) throw new Error('the id source is exhausted');
      return `${gateId}.${ids}`;
    };

    const result = await runInProcess(['--gates-dir', gates, '--store', storePath], {
      createId: failOnSecondRecord,
    });

    const report = expectReport(result, 64, 'configuration-error');
    expect(report.recordId).toBeNull();
    expect(report.gates.map((gate) => [gate.gateId, gate.decision])).toEqual([
      ['alpha', 'configuration-error'],
      ['beta', 'pass'],
    ]);
    expect(result.stderr).toContain('The release gate itself failed: the id source is exhausted');
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('exits 2, never 0 or 1, when the gate machinery itself fails', async () => {
    const gates = await gatesDirectory({ [FIXTURE_GATE_ID]: fixtureGateFile('regressing') });
    const result = await runInProcess(['--gates-dir', gates, '--store', directory]);
    const report = expectReport(result, 2, 'infrastructure-failure');
    expect(report.recordId).toBeNull();
    expect(result.stderr).toContain('The release gate itself failed');
  });
});

// These tests drive `git` itself (the functions under test spawn it), so the repository, its
// commits and every lookup run once here at module scope to stay off the per-test clock.
async function repositoryGit(repository: string, ...args: string[]): Promise<string> {
  const result = await runWithHangGuard(['git', ...args], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return result.stdout.toString().trim();
}

const checkedOutHead = await repositoryGit(PACKAGE_DIRECTORY, 'rev-parse', 'HEAD');
const gitScenarioDirectory = await mkdtemp(join(tmpdir(), 'release-gate-git-'));
const gitScenario = await (async () => {
  const distanceRepository = join(gitScenarioDirectory, 'distance');
  await mkdir(distanceRepository);
  await repositoryGit(distanceRepository, 'init', '--quiet');
  const revisions: string[] = [];
  for (const message of ['first', 'second', 'third']) {
    await repositoryGit(
      distanceRepository,
      'commit',
      '--quiet',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      message,
    );
    revisions.push(await repositoryGit(distanceRepository, 'rev-parse', 'HEAD'));
  }

  const headRepository = join(gitScenarioDirectory, 'head');
  await mkdir(headRepository);
  await repositoryGit(headRepository, 'init', '--quiet');
  const headBeforeCommit = gitHeadRevision(headRepository);
  await repositoryGit(
    headRepository,
    'commit',
    '--quiet',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'first',
  );

  return {
    distanceFirstToThird: gitRevisionDistance(revisions[0]!, revisions[2]!, distanceRepository),
    distanceToSelf: gitRevisionDistance(revisions[2]!, revisions[2]!, distanceRepository),
    distanceFromUnknown: gitRevisionDistance('0'.repeat(40), revisions[2]!, distanceRepository),
    distanceOutsideRepository: gitRevisionDistance(revisions[0]!, revisions[1]!),
    headBeforeCommit,
    headAfterCommit: gitHeadRevision(headRepository),
    expectedHead: await repositoryGit(headRepository, 'rev-parse', 'HEAD'),
    headOutsideRepository: gitHeadRevision(gitScenarioDirectory),
    headOfCheckout: gitHeadRevision(),
  };
})();

afterAll(async () => {
  await rm(gitScenarioDirectory, { recursive: true, force: true });
});

describe('gitRevisionDistance', () => {
  test('counts the commits between two revisions, and is undefined for one git does not know', () => {
    expect(gitScenario.distanceFirstToThird).toBe(2);
    expect(gitScenario.distanceToSelf).toBe(0);
    expect(gitScenario.distanceFromUnknown).toBeUndefined();
    expect(gitScenario.distanceOutsideRepository).toBeUndefined();
  });
});

describe('gitHeadRevision', () => {
  test('is the checked-out commit, and undefined outside a repository', () => {
    expect(gitScenario.headBeforeCommit).toBeUndefined();
    expect(gitScenario.headAfterCommit).toBe(gitScenario.expectedHead);
    expect(gitScenario.headOutsideRepository).toBeUndefined();
    expect(gitScenario.headOfCheckout).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
