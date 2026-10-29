import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { textValueStore } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing';
import { BunSQLiteStorage } from '@lostgradient/weft';

import { fixtureConfiguration } from '../src/fixtures/release-gate/fixture-regression';
import type { GateDecisionRecord } from '../src/gate';
import {
  createEvaluationHistory,
  type EvaluationHistory,
  type HistoricalRecord,
} from '../src/history';
import type { PromotionSignal } from '../src/promotion';
import {
  type GateEvaluatorDefinition,
  type GateEvaluatorLoader,
  loadGateEvaluator,
  runReleaseGate,
  type RunReleaseGateOptions,
} from '../src/release-gate';
import {
  FIXTURE_GATE_ID,
  fixtureGateFile,
  GATE_ACTOR,
  type GateFile,
  writeGates,
} from '../src/release-gate.test-support';
import {
  gitPackageSourceRevision,
  type PromotionSignalCommandOptions,
  runPromotionSignalCommand,
  workspaceDirectory,
} from './promotion-signal';
import { runReleaseGateCommand } from './release-gate';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');
const REVISION = '857d7dbf10e51718e77bc484145cd4a95f244afc';
const OTHER_REVISION = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';
const PACKAGE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DECIDED_AT = '2026-09-28T12:00:00.000Z';
const ISSUED_AT = '2026-09-28T13:00:00.000Z';
const RECORD_KEY_PREFIX = 'evaluation-history/records/';

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const result = await runWithHangGuard(['git', ...args], {
    cwd,
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

// Every `git` process this file needs runs at module scope, so none boots inside a test's budget.
const HEAD = await gitIn(PACKAGE_DIRECTORY, 'rev-parse', 'HEAD');
const HEAD_PACKAGE_TREE = await gitIn(PACKAGE_DIRECTORY, 'rev-parse', 'HEAD:testing/evaluation');

let directory: string;
let storePath: string;
let gateDirectories = 0;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'promotion-signal-command-'));
  storePath = join(directory, 'history.sqlite');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Report {
  readonly kind: string;
  readonly command: string | null;
  readonly result: string;
  readonly exitCode: number;
  readonly signal?: PromotionSignal;
  readonly stale?: readonly { readonly field: string }[];
  readonly problem?: string;
}

async function spawnScript(script: string, args: readonly string[]): Promise<CommandResult> {
  const child = spawnWithHangGuard(
    [process.execPath, 'run', '--cwd', PACKAGE_DIRECTORY, script, ...args],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * The checked-out repository as the command would read it, read once at module scope instead of on
 * each call: `HEAD` is checked out and its package tree is `HEAD_PACKAGE_TREE`.
 */
function checkedOut(changes: PromotionSignalCommandOptions = {}): PromotionSignalCommandOptions {
  return {
    currentRevision: () => HEAD,
    packageSourceRevision: (name, revision) =>
      name === '@lostgradient/evaluation' && revision === HEAD ? HEAD_PACKAGE_TREE : undefined,
    ...changes,
  };
}

/** The repository as a test pins it: `REVISION` checked out, at `ISSUED_AT`. */
function pinned(changes: PromotionSignalCommandOptions = {}): PromotionSignalCommandOptions {
  return {
    currentRevision: () => REVISION,
    packageSourceRevision: () => PACKAGE_TREE,
    now: () => Date.parse(ISSUED_AT),
    ...changes,
  };
}

async function runInProcess(
  args: readonly string[],
  options: PromotionSignalCommandOptions = pinned(),
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runPromotionSignalCommand(args, {
    ...options,
    output: {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    },
  });
  return { exitCode, stdout, stderr };
}

/** Stdout is exactly one report whose exit code matches `$?`, and stderr carries the verdict line. */
function expectReport(result: CommandResult, exitCode: number, outcome: string): Report {
  expect(result.exitCode).toBe(exitCode);
  const report = JSON.parse(result.stdout) as Report;
  expect(report).toMatchObject({
    kind: 'promotion-signal-report',
    schemaVersion: 1,
    result: outcome,
    exitCode,
  });
  expect(result.stdout).not.toContain('promotion-signal:');
  expect(result.stderr).toContain(`promotion-signal: ${outcome} (exit ${exitCode})\n`);
  return report;
}

async function withHistory<T>(
  work: (history: EvaluationHistory, store: ReturnType<typeof textValueStore>) => Promise<T>,
): Promise<T> {
  const store = textValueStore(new BunSQLiteStorage(storePath));
  try {
    return await work(createEvaluationHistory(store), store);
  } finally {
    await store.close();
  }
}

async function records(): Promise<HistoricalRecord[]> {
  return withHistory((history) => history.list());
}

/** Runs the gate into the store at `DECIDED_AT` and `REVISION` unless told otherwise. */
async function decide(
  gate: GateFile = fixtureGateFile(),
  options: Partial<RunReleaseGateOptions> = {},
): Promise<GateDecisionRecord> {
  gateDirectories += 1;
  const gatesDirectory = await writeGates(join(directory, `gates-${gateDirectories}`), {
    [FIXTURE_GATE_ID]: gate,
  });
  return withHistory(async (history) => {
    const result = await runReleaseGate({
      gatesDirectory,
      gateId: FIXTURE_GATE_ID,
      history,
      actor: GATE_ACTOR,
      now: () => Date.parse(DECIDED_AT),
      sourceRevision: REVISION,
      ...options,
    });
    if (result.decision === 'configuration-error') throw new Error(result.issues.join('; '));
    return result.historical.record;
  });
}

/** Loads evaluator modules as the command would, then changes the definition. */
function loadingWith(
  change: (definition: GateEvaluatorDefinition) => GateEvaluatorDefinition,
): GateEvaluatorLoader {
  return async (modulePath) => change(await loadGateEvaluator(modulePath));
}

function withConfiguration(changes: Record<string, unknown>): GateEvaluatorLoader {
  return loadingWith((definition) => ({
    ...definition,
    configuration: { ...(definition.configuration as Record<string, unknown>), ...changes },
  }));
}

const judge = fixtureConfiguration()['judge'] as Record<string, unknown>;

/**
 * Issuing from a failing decision exits 3 and from one recorded at another
 * revision exits 5, appending nothing. `run` reads the checked-out repository
 * and `now`, and the decisions are dated on that same clock: one dated at a
 * fixed instant expires a day later, after which `run` refuses it as expired
 * before it ever compares revisions.
 */
async function expectRefusalsAppendNothing(
  run: (args: readonly string[]) => Promise<CommandResult>,
  now: () => number,
): Promise<void> {
  const failing = await decide(fixtureGateFile('regressing'), { sourceRevision: HEAD, now });
  const elsewhere = await decide(fixtureGateFile(), { sourceRevision: OTHER_REVISION, now });
  const before = await records();

  const refused = await run(['issue', failing.id, '--store', storePath]);
  expect(expectReport(refused, 3, 'insufficient-evidence')).toMatchObject({
    reason: 'decision-not-passing',
  });

  const stale = await run(['issue', elsewhere.id, '--store', storePath]);
  expect(expectReport(stale, 5, 'stale').stale).toEqual([
    { field: 'sourceRevision', bound: OTHER_REVISION, current: HEAD },
  ] as never);
  expect(stale.stderr).toContain(`  sourceRevision: bound "${OTHER_REVISION}", now "${HEAD}"`);

  expect(await records()).toEqual(before);
}

/**
 * Runs the committed gate through the command's exported entry point, as
 * `bun run release-gate --gate <id> --store <store>` would, and returns the
 * decision it recorded. The gate run is setup, not the behavior under test, so
 * it stays in this process: spawning it would put a `bun` boot inside the
 * per-test budget.
 */
async function committedGateRun(): Promise<string> {
  let stdout = '';
  const exitCode = await runReleaseGateCommand(['--gate', FIXTURE_GATE_ID, '--store', storePath], {
    sourceRevision: HEAD,
    revisionDistance: () => undefined,
    output: { stdout: { write: (text: string) => (stdout += text) }, stderr: { write: () => 0 } },
  });
  expect(exitCode).toBe(0);
  return (JSON.parse(stdout) as { recordId: string }).recordId;
}

/** What `issue` on the committed gate's decision binds, against the checked-out repository. */
function expectIssuedSignal(report: Report, gateDecisionRecordId: string): void {
  expect(report.command).toBe('issue');
  expect(report.signal).toMatchObject({
    package: {
      name: '@lostgradient/evaluation',
      sourceRevision: HEAD_PACKAGE_TREE,
    },
    model: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
    promptVersion: 'fixture-judge-prompt-1',
    dataset: { id: 'capitals', version: 'capitals-2026-09' },
    sourceRevision: HEAD,
    gateDecisionRecordId,
    overrideRecordIds: [],
    actor: userInfo().username,
  });
}

// The real process is the behavior under test (script wiring, stdout, stderr and exit code), so it
// runs once here at module scope to stay off the per-test clock. The gate run and the verification
// are in process, in a directory the hooks above replace for each test.
const spawnedIssue = await (async () => {
  directory = await mkdtemp(join(tmpdir(), 'promotion-signal-command-spawn-'));
  storePath = join(directory, 'history.sqlite');
  try {
    const gateDecisionRecordId = await committedGateRun();
    const issued = await spawnScript('promotion-signal', [
      'issue',
      '--gate',
      FIXTURE_GATE_ID,
      '--store',
      storePath,
    ]);
    const signalId = (JSON.parse(issued.stdout) as Report).signal?.signalId;
    const verified = await runInProcess(['verify', signalId ?? '', '--store', storePath], {});
    return { gateDecisionRecordId, issued, verified };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

/**
 * The one test that boots a real `bun` process: it proves the
 * `promotion-signal` script is wired to the entry point and that stdout,
 * stderr and the process exit code carry the command's result, against the
 * real clock and the checked-out repository. Every exit code the command maps
 * is asserted in process below, so nothing else here pays for a spawn inside
 * the per-test budget.
 */
describe('promotion-signal (spawned bun process)', () => {
  test('issue --gate fixture-regression exits 0 with one JSON document after the committed gate passes, and verify exits 0', () => {
    const { gateDecisionRecordId, issued, verified } = spawnedIssue;

    const report = expectReport(issued, 0, 'issued');
    expectIssuedSignal(report, gateDecisionRecordId);
    expect(issued.stderr).toContain(`Issued promotion signal "${report.signal!.signalId}"`);

    expect(expectReport(verified, 0, 'valid').signal).toEqual(report.signal);
  });
});

// This scenario exists to prove the command reads the checked-out repository when nothing is
// injected, so its whole run happens here at module scope to stay off the per-test clock. It
// borrows the shared directory and store variables, which the hooks above replace before each test.
const defaultIssue = await (async () => {
  directory = await mkdtemp(join(tmpdir(), 'promotion-signal-command-default-'));
  storePath = join(directory, 'history.sqlite');
  try {
    const decision = await decide(fixtureGateFile(), { sourceRevision: HEAD });
    return await runInProcess(['issue', decision.id, '--store', storePath], {
      now: () => Date.parse(ISSUED_AT),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

describe('runPromotionSignalCommand', () => {
  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issue --gate fixture-regression exits 0 with one JSON document after the committed gate passes, and verify exits 0', async () => {
    const gateDecisionRecordId = await committedGateRun();

    const issued = await runInProcess(
      ['issue', '--gate', FIXTURE_GATE_ID, '--store', storePath],
      checkedOut(),
    );

    const report = expectReport(issued, 0, 'issued');
    expectIssuedSignal(report, gateDecisionRecordId);
    expect(issued.stderr).toContain(`Issued promotion signal "${report.signal!.signalId}"`);

    const verified = await runInProcess(
      ['verify', report.signal!.signalId, '--store', storePath],
      checkedOut(),
    );
    expect(expectReport(verified, 0, 'valid').signal).toEqual(report.signal);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('refuses a failing decision with 3 and another revision with 5 on the real clock, appending nothing', async () => {
    // The real clock, as a person's run reads it: the decisions are dated on it too.
    await expectRefusalsAppendNothing(
      (args) => runInProcess(args, checkedOut()),
      () => Date.now(),
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('refuses a failing decision with 3 and another revision with 5 however long after `DECIDED_AT` it runs', async () => {
    // A run on the real clock with decisions dated at `DECIDED_AT` began
    // failing a day later, so this one pins `now` instead.
    const longAfter = Date.parse(DECIDED_AT) + 5 * 365 * 24 * 60 * 60 * 1000;
    await expectRefusalsAppendNothing(
      (args) => runInProcess(args, checkedOut({ now: () => longAfter })),
      () => longAfter,
    );
  });

  test('issues against the checked-out repository by default', () => {
    expect(expectReport(defaultIssue, 0, 'issued').signal).toMatchObject({
      package: {
        sourceRevision: HEAD_PACKAGE_TREE,
      },
      sourceRevision: HEAD,
    });
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issue on a failing or an expired decision exits 3 and appends nothing', async () => {
    const failing = await decide(fixtureGateFile('regressing'));
    const passing = await decide();
    const before = await records();

    const refused = await runInProcess(['issue', failing.id, '--store', storePath]);
    expect(expectReport(refused, 3, 'insufficient-evidence')).toMatchObject({
      reason: 'decision-not-passing',
      problem: `Gate decision "${failing.id}" is regression, not pass`,
    });

    const expired = await runInProcess(
      ['issue', passing.id, '--store', storePath],
      pinned({ now: () => Date.parse('2026-09-29T12:00:00.000Z') }),
    );
    expect(expectReport(expired, 3, 'insufficient-evidence')).toMatchObject({
      reason: 'decision-expired',
    });
    expect(expired.stderr).toContain(
      `Gate decision "${passing.id}" expired at 2026-09-29T12:00:00.000Z`,
    );

    expect(await records()).toEqual(before);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issue on a passing decision whose recorded revision is not the injected current one exits 5 and appends nothing', async () => {
    const decision = await decide();
    const before = await records();

    const result = await runInProcess(
      ['issue', decision.id, '--store', storePath],
      pinned({ currentRevision: () => OTHER_REVISION }),
    );

    expect(expectReport(result, 5, 'stale')).toMatchObject({
      gateDecisionRecordId: decision.id,
      stale: [{ field: 'sourceRevision', bound: REVISION, current: OTHER_REVISION }],
    });
    expect(result.stderr).toContain(
      `Gate decision "${decision.id}" no longer matches the repository:\n  sourceRevision:`,
    );
    expect(await records()).toEqual(before);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each<[string, PromotionSignalCommandOptions]>([
    ['package.sourceRevision', pinned({ packageSourceRevision: () => 'f'.repeat(40) })],
    [
      'model.model',
      pinned({
        loadEvaluator: withConfiguration({ judge: { ...judge, model: 'claude-opus-4-8' } }),
      }),
    ],
    [
      'model.effort',
      pinned({ loadEvaluator: withConfiguration({ judge: { ...judge, effort: 'high' } }) }),
    ],
    [
      'promptVersion',
      pinned({ loadEvaluator: withConfiguration({ promptVersion: 'fixture-judge-prompt-2' }) }),
    ],
    [
      'dataset.version',
      pinned({
        loadEvaluator: loadingWith((definition) => ({
          ...definition,
          configuration: {
            ...(definition.configuration as Record<string, unknown>),
            datasetVersion: 'capitals-2026-10',
          },
          dataset: {
            ...(definition.dataset as Record<string, unknown>),
            version: 'capitals-2026-10',
          },
        })),
      }),
    ],
    ['evaluator.digest', pinned({ loadEvaluator: withConfiguration({ passThreshold: 0.5 }) })],
    ['sourceRevision', pinned({ currentRevision: () => OTHER_REVISION })],
  ])('verify exits 5 and names %s once it alone moves', async (field, moved) => {
    const decision = await decide();
    const issued = expectReport(
      await runInProcess(['issue', decision.id, '--store', storePath]),
      0,
      'issued',
    );
    const signalId = issued.signal!.signalId;
    expectReport(await runInProcess(['verify', signalId, '--store', storePath]), 0, 'valid');

    const result = await runInProcess(['verify', signalId, '--store', storePath], moved);

    const report = expectReport(result, 5, 'stale');
    expect(report.stale!.map((entry) => entry.field)).toContain(field);
    expect(result.stderr).toContain(`Promotion signal "${signalId}" is stale:\n`);
    expect(result.stderr).toContain(`  ${field}: bound `);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('verify exits 3 for a signal past its expiry', async () => {
    const decision = await decide();
    const { signal } = expectReport(
      await runInProcess(['issue', decision.id, '--store', storePath]),
      0,
      'issued',
    );

    const result = await runInProcess(
      ['verify', signal!.signalId, '--store', storePath],
      pinned({ now: () => Date.parse(signal!.expiresAt) }),
    );

    expect(expectReport(result, 3, 'expired')).toMatchObject({
      command: 'verify',
      checkedAt: signal!.expiresAt,
    });
    expect(result.stderr).toContain(
      `Promotion signal "${signal!.signalId}" expired at ${signal!.expiresAt}`,
    );
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issuing twice from one decision gives two signals and leaves the first record unchanged', async () => {
    const decision = await decide();
    const first = expectReport(
      await runInProcess(['issue', decision.id, '--store', storePath]),
      0,
      'issued',
    );
    const before = await withHistory((history) => history.read(first.signal!.signalId));

    const second = expectReport(
      await runInProcess(['issue', decision.id, '--store', storePath]),
      0,
      'issued',
    );

    expect(second.signal!.signalId).not.toBe(first.signal!.signalId);
    expect(await withHistory((history) => history.read(first.signal!.signalId))).toEqual(before);
    expect(before?.record).toMatchObject({ signal: { digest: first.signal!.digest } });
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issue --gate issues from the newest decision of the gate, and exits 3 for a gate never run', async () => {
    await decide();
    const newest = await decide(fixtureGateFile(), {
      now: () => Date.parse('2026-09-28T12:30:00.000Z'),
    });

    const issued = await runInProcess(['issue', '--gate', FIXTURE_GATE_ID, '--store', storePath]);
    expect(expectReport(issued, 0, 'issued').signal).toMatchObject({
      gateDecisionRecordId: newest.id,
    });

    const never = await runInProcess(['issue', '--gate', 'never-run', '--store', storePath]);
    expect(expectReport(never, 3, 'insufficient-evidence')).toMatchObject({
      gateId: 'never-run',
      reason: 'decision-missing',
      problem: 'No gate decision for gate "never-run"',
    });
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('names the issuing principal: the current user unless --actor names someone', async () => {
    const decision = await decide();
    const byDefault = await runInProcess(['issue', decision.id, '--store', storePath]);
    const named = await runInProcess([
      'issue',
      decision.id,
      '--store',
      storePath,
      '--actor',
      'agent-7',
    ]);
    expect(expectReport(byDefault, 0, 'issued').signal?.actor).toBe(userInfo().username);
    expect(expectReport(named, 0, 'issued').signal?.actor).toBe('agent-7');
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('uses the id source it is given', async () => {
    const decision = await decide();
    const result = await runInProcess(
      ['issue', decision.id, '--store', storePath],
      pinned({ createId: (from) => `${from.id}.promoted` }),
    );
    expect(expectReport(result, 0, 'issued').signal?.signalId).toBe(`${decision.id}.promoted`);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('reports the problem when current values cannot be resolved, or no signal exists', async () => {
    const decision = await decide();
    const unresolvable = await runInProcess(
      ['issue', decision.id, '--store', storePath],
      pinned({ currentRevision: () => undefined }),
    );
    expect(expectReport(unresolvable, 3, 'unresolvable')).toMatchObject({
      problem: 'The current source revision cannot be determined',
    });
    expect(unresolvable.stderr).toStartWith('The current source revision cannot be determined\n');

    const missing = await runInProcess(['verify', 'never-issued', '--store', storePath]);
    expect(expectReport(missing, 3, 'insufficient-evidence')).toMatchObject({
      reason: 'signal-missing',
    });
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('issue from a store that does not exist exits 3 without creating it', async () => {
    const absent = join(directory, 'absent.sqlite');
    const result = await runInProcess(['issue', '--gate', FIXTURE_GATE_ID, '--store', absent]);
    expectReport(result, 3, 'insufficient-evidence');
    expect(existsSync(absent)).toBe(false);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test.each<[string, string[]]>([
    ['no command', []],
    ['an unknown command', ['promote', 'x']],
    ['issue with both an id and --gate', ['issue', 'decision-1', '--gate', FIXTURE_GATE_ID]],
    ['issue with neither an id nor --gate', ['issue']],
    ['issue with an empty --actor', ['issue', 'decision-1', '--actor', '']],
    ['verify without a signal id', ['verify']],
    ['verify with --gate', ['verify', 'signal-1', '--gate', FIXTURE_GATE_ID]],
    ['verify with --actor', ['verify', 'signal-1', '--actor', 'agent-7']],
    ['an unknown option', ['issue', 'decision-1', '--force']],
  ])('exits 64 for %s, with usage on stderr', async (_label, args) => {
    const result = await runInProcess([...args, '--store', storePath]);
    const report = expectReport(result, 64, 'usage-error');
    expect(report.command).toBeNull();
    expect(result.stderr).toContain('Usage: bun run --cwd testing/evaluation promotion-signal');
    expect(existsSync(storePath)).toBe(false);
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('exits 65 when a record it reads is corrupt', async () => {
    const decision = await decide();
    const { signal } = expectReport(
      await runInProcess(['issue', decision.id, '--store', storePath]),
      0,
      'issued',
    );
    await withHistory(async (_history, store) => {
      await store.set(`${RECORD_KEY_PREFIX}${decision.id}`, '{"corrupt":true}');
    });

    for (const args of [
      ['issue', decision.id],
      ['issue', '--gate', FIXTURE_GATE_ID],
      ['verify', signal!.signalId],
    ]) {
      const result = await runInProcess([...args, '--store', storePath]);
      expect(expectReport(result, 65, 'corrupt-record')).toMatchObject({ recordId: decision.id });
      expect(result.stderr).toContain(`Historical record "${decision.id}"`);
    }
  });

  // spawn-free: the revision readers are injected here, so the command never runs git.
  test('propagates a failure that is neither a usage error nor corruption', async () => {
    expect(
      await throwingRejectionOf(runInProcess(['verify', 'signal-1', '--store', directory])),
    ).toThrow();
  });
});

// These tests drive `git` itself (the function under test spawns it), so the repository, its two
// commits and every revision lookup run once here at module scope to stay off the per-test clock.
const gitScenarioDirectory = await mkdtemp(join(tmpdir(), 'promotion-signal-git-'));
const gitScenarioRepository = join(gitScenarioDirectory, 'repository');
const gitScenarioNotARepository = join(gitScenarioDirectory, 'not-a-repository');
const checkedOutPackageTree = await gitPackageSourceRevision('@lostgradient/evaluation', HEAD);
const gitScenario = await (async () => {
  const repository = gitScenarioRepository;
  await mkdir(join(repository, 'packages', 'alpha'), { recursive: true });
  await mkdir(join(repository, 'packages', 'broken'), { recursive: true });
  await mkdir(gitScenarioNotARepository, { recursive: true });
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: [7, 'packages/*'] }),
  );
  await writeFile(join(repository, 'packages', 'alpha', 'package.json'), '{"name":"alpha"}');
  await writeFile(join(repository, 'packages', 'broken', 'package.json'), '{ not json');
  await gitIn(repository, 'init', '--quiet');
  const beforeFirstCommit = await gitPackageSourceRevision('alpha', 'HEAD', repository);
  await gitIn(repository, 'add', '.');
  await gitIn(repository, 'commit', '--quiet', '--no-gpg-sign', '-m', 'first');
  const first = await gitIn(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'packages', 'alpha', 'index.ts'), 'export {};\n');
  await gitIn(repository, 'add', '.');
  await gitIn(repository, 'commit', '--quiet', '--no-gpg-sign', '-m', 'second');

  return {
    beforeFirstCommit,
    tree: await gitPackageSourceRevision('alpha', first, repository),
    expectedTree: await gitIn(repository, 'rev-parse', `${first}:packages/alpha`),
    atHead: await gitPackageSourceRevision('alpha', 'HEAD', repository),
    missingWorkspace: await gitPackageSourceRevision('missing', 'HEAD', repository),
    unknownRevision: await gitPackageSourceRevision('alpha', OTHER_REVISION, repository),
    notARepository: await gitPackageSourceRevision('alpha', 'HEAD', gitScenarioNotARepository),
  };
})();

afterAll(async () => {
  await rm(gitScenarioDirectory, { recursive: true, force: true });
});

describe('gitPackageSourceRevision', () => {
  test('is the git tree of the named workspace at a revision of the checked-out repository', async () => {
    expect(checkedOutPackageTree).toBe(HEAD_PACKAGE_TREE);
    expect(
      await workspaceDirectory('@lostgradient/evaluation', resolve(PACKAGE_DIRECTORY, '..', '..')),
    ).toBe('testing/evaluation');
  });

  test('finds workspaces by name, and is undefined for anything it cannot resolve', async () => {
    const repository = gitScenarioRepository;
    expect(gitScenario.beforeFirstCommit).toBeUndefined();
    expect(gitScenario.tree).toBe(gitScenario.expectedTree);
    expect(gitScenario.atHead).not.toBe(gitScenario.tree);
    expect(gitScenario.missingWorkspace).toBeUndefined();
    expect(gitScenario.unknownRevision).toBeUndefined();
    expect(gitScenario.notARepository).toBeUndefined();

    await rm(join(repository, 'package.json'));
    expect(await workspaceDirectory('alpha', repository)).toBeUndefined();
    await writeFile(join(repository, 'package.json'), 'null');
    expect(await workspaceDirectory('alpha', repository)).toBeUndefined();
  });
});
