import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing';
import { BunSQLiteStorage, textValueStore } from '@lostgradient/weft';

import type { EvaluationRunRecord } from '../src/evaluation-run';
import baselineFixture from '../src/fixtures/history/baseline-run.json';
import candidateFixture from '../src/fixtures/history/candidate-run.json';
import { createEvaluationHistory, type HistoricalRecord } from '../src/history';
import { runReleaseGate } from '../src/release-gate';
import {
  COMMITTED_GATES_DIRECTORY,
  FIXTURE_GATE_ID,
  GATE_ACTOR,
} from '../src/release-gate.test-support';
import { DEFAULT_HISTORY_STORE, runHistoryCommand } from './history';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');
const BASELINE = baselineFixture as EvaluationRunRecord;
const CANDIDATE = candidateFixture as EvaluationRunRecord;

let directory: string;
let storePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'evaluation-history-'));
  storePath = join(directory, 'history.sqlite');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Appends `records` to the SQLite store through this process's own connection, then closes it. */
async function seed(...records: EvaluationRunRecord[]): Promise<HistoricalRecord[]> {
  return seedStore(storePath, ...records);
}

async function seedStore(
  path: string,
  ...records: EvaluationRunRecord[]
): Promise<HistoricalRecord[]> {
  const store = textValueStore(new BunSQLiteStorage(path));
  try {
    const history = createEvaluationHistory(store);
    const appended: HistoricalRecord[] = [];
    for (const record of records) appended.push(await history.append(record));
    return appended;
  } finally {
    await store.close();
  }
}

/** Changes one digit of a stored row, bypassing the history's append-only API. */
async function corrupt(id: string): Promise<void> {
  const store = textValueStore(new BunSQLiteStorage(storePath));
  try {
    const key = `evaluation-history/records/${id}`;
    const text = (await store.get(key))!;
    const changed = text.replace('"latencyMilliseconds":1000', '"latencyMilliseconds":1001');
    expect(changed).not.toBe(text);
    await store.set(key, changed);
  } finally {
    await store.close();
  }
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the package's `history` script in a separate `bun` process, as a person would. */
async function spawnHistory(...args: string[]): Promise<CommandResult> {
  const child = spawnWithHangGuard(
    [process.execPath, 'run', '--cwd', PACKAGE_DIRECTORY, 'history', ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Runs the command in this process, capturing what it writes. */
async function runInProcess(...args: string[]): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runHistoryCommand(args, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { exitCode, stdout, stderr };
}

const EXPECTED_COMPARISON = {
  verdicts: { passFraction: { baseline: 1, candidate: 0.75, delta: -0.25 } },
  criteria: [
    {
      name: 'names-the-capital',
      passFraction: { baseline: 1, candidate: 0.75, delta: -0.25 },
      meanScore: { baseline: 1, candidate: 0.75, delta: -0.25 },
    },
    {
      name: 'concise',
      passFraction: { baseline: 1, candidate: 0.5, delta: -0.5 },
      meanScore: { baseline: 1, candidate: 0.625, delta: -0.375 },
    },
    {
      name: 'no-web-search',
      passFraction: { baseline: 1, candidate: 1, delta: 0 },
      meanScore: { baseline: 1, candidate: 1, delta: 0 },
    },
    {
      name: 'follows-style-guide',
      passFraction: { baseline: 1, candidate: 1, delta: 0 },
      meanScore: { baseline: 1, candidate: 1, delta: 0 },
    },
  ],
  costUsd: { baseline: 1, candidate: 1.5, delta: 0.5 },
  latencyMilliseconds: { baseline: 1000, candidate: 1250, delta: 250 },
};

// The real process is the behavior under test (a second process reads what this one wrote), so it
// runs once here at module scope to stay off the per-test clock.
const spawnedShow = await (async () => {
  const spawnDirectory = await mkdtemp(join(tmpdir(), 'evaluation-history-spawn-'));
  try {
    const spawnStorePath = join(spawnDirectory, 'history.sqlite');
    const [appended] = await seedStore(spawnStorePath, BASELINE);
    const result = await spawnHistory('show', BASELINE.id, '--store', spawnStorePath);
    return { appended: appended!, ...result };
  } finally {
    await rm(spawnDirectory, { recursive: true, force: true });
  }
})();

/**
 * The one test that boots a real `bun` process: it proves the `history` script
 * is wired to the entry point and that a second process reads, with an equal
 * digest, the record this one wrote. Every other exit code and output is
 * asserted in process below, so nothing else here pays for a spawn inside the
 * per-test budget.
 */
describe('history (spawned bun process)', () => {
  test('show reads, in a second process, the record this process wrote, with an equal digest', async () => {
    const { appended, exitCode, stdout } = spawnedShow;

    expect(exitCode).toBe(0);
    const shown = JSON.parse(stdout) as HistoricalRecord;
    expect(shown.digest).toBe(appended.digest);
    expect(shown).toEqual(appended);
  });
});

describe('runHistoryCommand', () => {
  test('list exits 0 and prints one JSON line per record, oldest first', async () => {
    // Appended newest first, so the order printed is the command's own.
    const [candidate, baseline] = await seed(CANDIDATE, BASELINE);

    const { exitCode, stdout } = await runInProcess('list', '--store', storePath);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const summaries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(summaries).toEqual([
      {
        id: BASELINE.id,
        kind: 'evaluation-run',
        recordedAt: BASELINE.recordedAt,
        digest: baseline!.digest,
        evaluator: BASELINE.evaluator,
        dataset: BASELINE.dataset,
        codeRevision: BASELINE.codeRevision,
        outcomes: BASELINE.outcomes,
        passFraction: 1,
      },
      {
        id: CANDIDATE.id,
        kind: 'evaluation-run',
        recordedAt: CANDIDATE.recordedAt,
        digest: candidate!.digest,
        evaluator: CANDIDATE.evaluator,
        dataset: CANDIDATE.dataset,
        codeRevision: CANDIDATE.codeRevision,
        outcomes: CANDIDATE.outcomes,
        passFraction: 0.75,
      },
    ]);
  });

  test('list treats a store that does not exist as an empty history, without creating it', async () => {
    const { exitCode, stdout } = await runInProcess('list', '--store', storePath);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(storePath)).toBe(false);
  });

  test('show prints the record this process wrote, with an equal digest', async () => {
    const [appended] = await seed(BASELINE);

    const { exitCode, stdout } = await runInProcess('show', BASELINE.id, '--store', storePath);

    expect(exitCode).toBe(0);
    const shown = JSON.parse(stdout) as HistoricalRecord;
    expect(shown.digest).toBe(appended!.digest);
    expect(shown).toEqual(appended!);
  });

  test('show exits 64 for an unknown record and 65 for a corrupt one', async () => {
    await seed(BASELINE);
    await corrupt(BASELINE.id);

    const unknown = await runInProcess('show', 'run-never-recorded', '--store', storePath);
    expect(unknown.exitCode).toBe(64);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('No historical record "run-never-recorded"');

    const corrupted = await runInProcess('show', BASELINE.id, '--store', storePath);
    expect(corrupted.exitCode).toBe(65);
    expect(corrupted.stdout).toBe('');
    expect(corrupted.stderr).toContain(
      `Historical record "${BASELINE.id}" does not match its digest`,
    );
  });

  test('compare prints per-criterion pass-fraction and mean-score deltas with cost and latency', async () => {
    const [baseline, candidate] = await seed(BASELINE, CANDIDATE);

    const { exitCode, stdout } = await runInProcess(
      'compare',
      BASELINE.id,
      CANDIDATE.id,
      '--store',
      storePath,
    );

    expect(exitCode).toBe(0);
    const comparison = JSON.parse(stdout) as Record<string, unknown>;
    expect(comparison).toMatchObject(EXPECTED_COMPARISON);
    expect(comparison['kind']).toBe('evaluation-run-comparison');
    expect(comparison['baseline']).toMatchObject({ id: BASELINE.id, digest: baseline!.digest });
    expect(comparison['candidate']).toMatchObject({ id: CANDIDATE.id, digest: candidate!.digest });
  });

  test('defaults to the package’s ignored .cache store', () => {
    expect(DEFAULT_HISTORY_STORE).toBe(
      join(PACKAGE_DIRECTORY, '.cache', 'evaluation-history.sqlite'),
    );
  });

  test.each([
    ['no command', []],
    ['an unknown command', ['delete', 'run-baseline']],
    ['show without a record id', ['show']],
    ['compare with one record id', ['compare', 'run-baseline']],
    ['list with an operand', ['list', 'run-baseline']],
    ['an unknown option', ['list', '--force']],
    ['--store without a path', ['list', '--store']],
  ])('exits 64 with usage on stderr for %s', async (_label, args) => {
    const { exitCode, stdout, stderr } = await runInProcess(...args);
    expect(exitCode).toBe(64);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage: bun run --cwd testing/evaluation history');
  });

  test('prints each command’s JSON on stdout', async () => {
    const [baseline] = await seed(BASELINE, CANDIDATE);

    const listed = await runInProcess('list', '--store', storePath);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trimEnd().split('\n')).toHaveLength(2);

    const shown = await runInProcess('show', BASELINE.id, '--store', storePath);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(baseline!);

    const compared = await runInProcess('compare', BASELINE.id, CANDIDATE.id, '--store', storePath);
    expect(compared.exitCode).toBe(0);
    expect(JSON.parse(compared.stdout)).toMatchObject(EXPECTED_COMPARISON);
  });

  test('compare exits 64 when either record is unknown', async () => {
    await seed(BASELINE);
    const missingCandidate = await runInProcess(
      'compare',
      BASELINE.id,
      CANDIDATE.id,
      '--store',
      storePath,
    );
    expect(missingCandidate.exitCode).toBe(64);
    expect(missingCandidate.stderr).toContain(`No historical record "${CANDIDATE.id}"`);

    const missingBaseline = await runInProcess(
      'compare',
      CANDIDATE.id,
      BASELINE.id,
      '--store',
      storePath,
    );
    expect(missingBaseline.exitCode).toBe(64);
    expect(missingBaseline.stderr).toContain(`No historical record "${CANDIDATE.id}"`);
  });

  test('list and compare exit 65 when a record they read is corrupt', async () => {
    await seed(BASELINE, CANDIDATE);
    await corrupt(BASELINE.id);

    const listed = await runInProcess('list', '--store', storePath);
    expect(listed.exitCode).toBe(65);
    expect(listed.stdout).toBe('');

    const compared = await runInProcess('compare', BASELINE.id, CANDIDATE.id, '--store', storePath);
    expect(compared.exitCode).toBe(65);
    expect(compared.stderr).toContain(`Historical record "${BASELINE.id}"`);
  });

  test('lists gate decisions and overrides beside runs, and compares only evaluation runs', async () => {
    const [baseline] = await seed(BASELINE);
    const store = textValueStore(new BunSQLiteStorage(storePath));
    let decisionId: string;
    try {
      const history = createEvaluationHistory(store);
      const result = await runReleaseGate({
        gatesDirectory: COMMITTED_GATES_DIRECTORY,
        gateId: FIXTURE_GATE_ID,
        history,
        actor: GATE_ACTOR,
        now: () => Date.parse('2026-09-28T14:00:00.000Z'),
      });
      decisionId = result.decision === 'configuration-error' ? '' : result.historical.record.id;
      await history.append({
        kind: 'gate-override',
        schemaVersion: 1,
        id: 'override-permanent',
        recordedAt: '2026-09-28T15:00:00.000Z',
        gateId: FIXTURE_GATE_ID,
        gateDecisionId: decisionId,
        actor: 'release-manager',
        reason: 'Rebaseline.',
        permanentBaselineChange: true,
        evidence: ['https://example.test/review/7'],
      });
    } finally {
      await store.close();
    }

    const listed = await runInProcess('list', '--store', storePath);
    expect(listed.exitCode).toBe(0);
    const summaries = listed.stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(summaries).toEqual([
      expect.objectContaining({
        id: BASELINE.id,
        kind: 'evaluation-run',
        digest: baseline!.digest,
      }),
      expect.objectContaining({
        id: decisionId,
        kind: 'gate-decision',
        gateId: FIXTURE_GATE_ID,
        decision: 'pass',
        actor: GATE_ACTOR,
        dataset: { id: 'capitals', version: 'capitals-2026-09' },
      }),
      expect.objectContaining({
        id: 'override-permanent',
        kind: 'gate-override',
        gateDecisionId: decisionId,
        expiresAt: null,
        permanentBaselineChange: true,
      }),
    ]);

    for (const args of [
      [decisionId, BASELINE.id],
      [BASELINE.id, 'override-permanent'],
    ]) {
      const compared = await runInProcess('compare', ...args, '--store', storePath);
      expect(compared.exitCode).toBe(64);
      expect(compared.stdout).toBe('');
      expect(compared.stderr).toContain('record; compare takes two evaluation runs');
    }
  });

  test('lists promotion signals with what they bind, and never compares them', async () => {
    const signal = {
      signalId: 'fixture-regression.signal-1',
      package: {
        name: '@lostgradient/evaluation',
        sourceRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      },
      model: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' as const },
      promptVersion: 'fixture-judge-prompt-1',
      dataset: { id: 'capitals', version: 'capitals-2026-09' },
      evaluator: { name: 'fixture-regression', revision: 1, digest: 'b'.repeat(64) },
      sourceRevision: '857d7dbf10e51718e77bc484145cd4a95f244afc',
      gateDecisionRecordId: 'fixture-regression.decision-1',
      overrideRecordIds: [],
      decidedAt: '2026-09-28T12:00:00.000Z',
      issuedAt: '2026-09-28T12:30:00.000Z',
      actor: 'release-owner',
      expiresAt: '2026-09-29T12:00:00.000Z',
      digest: 'c'.repeat(64),
    };
    const store = textValueStore(new BunSQLiteStorage(storePath));
    try {
      await createEvaluationHistory(store).append({
        kind: 'promotion-signal',
        schemaVersion: 1,
        id: signal.signalId,
        recordedAt: signal.issuedAt,
        signal,
      });
    } finally {
      await store.close();
    }

    const listed = await runInProcess('list', '--store', storePath);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({
      id: signal.signalId,
      kind: 'promotion-signal',
      recordedAt: signal.issuedAt,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      gateDecisionRecordId: signal.gateDecisionRecordId,
      actor: signal.actor,
      package: signal.package,
      sourceRevision: signal.sourceRevision,
      expiresAt: signal.expiresAt,
    });
    const compared = await runInProcess(
      'compare',
      signal.signalId,
      signal.signalId,
      '--store',
      storePath,
    );
    expect(compared.exitCode).toBe(64);
    expect(compared.stderr).toContain(
      'is a promotion-signal record; compare takes two evaluation runs',
    );
  });

  test('propagates a failure that is neither a usage error nor corruption', async () => {
    expect(await throwingRejectionOf(runInProcess('list', '--store', directory))).toThrow();
  });
});
