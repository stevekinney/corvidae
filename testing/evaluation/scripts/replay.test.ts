import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/weft';

import type { GateDecisionRecord } from '../src/gate';
import { createEvaluationHistory, type HistoricalRecord } from '../src/history';
import { type GateEvaluatorLoader, loadGateEvaluator } from '../src/release-gate';
import {
  evaluatorModule,
  FIXTURE_GATE_ID,
  fixtureGateFile,
  type GateFile,
  writeGates,
} from '../src/release-gate.test-support';
import { runReleaseGateCommand } from './release-gate';
import { runReplayCommand } from './replay';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');
// The revision is incidental to a replay, so it is read once here and injected into the gate run.
const headRun = await runWithHangGuard(['git', 'rev-parse', 'HEAD'], { cwd: PACKAGE_DIRECTORY });
const HEAD = headRun.stdout.toString().trim();

let directory: string;
let storePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'replay-command-'));
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
 * Runs one gate through the command's exported entry point and returns the id
 * it recorded. The gate run is setup, not the behavior under test, so it stays
 * in this process: spawning it would put a `bun` boot inside every test's
 * per-test budget.
 */
async function gateRun(
  gate: GateFile = fixtureGateFile(),
  loadEvaluator?: GateEvaluatorLoader,
): Promise<string> {
  const gates = await writeGates(join(directory, 'gates'), { [FIXTURE_GATE_ID]: gate });
  let stdout = '';
  const exitCode = await runReleaseGateCommand(
    ['--gate', FIXTURE_GATE_ID, '--gates-dir', gates, '--store', storePath],
    {
      loadEvaluator,
      sourceRevision: HEAD,
      revisionDistance: () => undefined,
      output: { stdout: { write: (text: string) => (stdout += text) }, stderr: { write: () => 0 } },
    },
  );
  expect([0, 1]).toContain(exitCode);
  return (JSON.parse(stdout) as { recordId: string }).recordId;
}

async function withHistory<T>(
  work: (
    history: ReturnType<typeof createEvaluationHistory>,
    store: ReturnType<typeof textValueStore>,
  ) => Promise<T>,
): Promise<T> {
  const store = textValueStore(new BunSQLiteStorage(storePath));
  try {
    return await work(createEvaluationHistory(store), store);
  } finally {
    await store.close();
  }
}

async function runInProcess(
  args: readonly string[],
  loadEvaluator?: GateEvaluatorLoader,
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runReplayCommand(args, {
    loadEvaluator,
    output: {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    },
  });
  return { exitCode, stdout, stderr };
}

// The real process is the behavior under test (script wiring, stdout, stderr and exit code), so it
// runs once here at module scope to stay off the per-test clock. The gate run it replays is set up
// in process, in a directory the hooks below replace for each test.
const spawnedReplay = await (async () => {
  directory = await mkdtemp(join(tmpdir(), 'replay-command-spawn-'));
  storePath = join(directory, 'history.sqlite');
  try {
    const recordId = await gateRun();
    const result = await spawnScript('replay', [
      '--gate',
      FIXTURE_GATE_ID,
      '--latest',
      '--store',
      storePath,
    ]);
    return { recordId, result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

/**
 * The one test that boots a real `bun` process: it proves the `replay` script
 * is wired to the entry point and that stdout, stderr and the process exit code
 * carry the command's result. Every exit-code mapping is asserted in process
 * below, so nothing else here pays for a spawn inside the per-test budget.
 */
describe('replay (spawned bun process)', () => {
  test('replay --gate fixture-regression --latest exits 0 after a gate run', async () => {
    const { recordId, result } = spawnedReplay;

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'replay-report',
      schemaVersion: 1,
      result: 'match',
      recordId,
      gateId: FIXTURE_GATE_ID,
      decision: 'pass',
    });
    expect(result.stderr).toContain(`Replay of "${recordId}" matches: pass`);
  });
});

describe('runReplayCommand', () => {
  // spawn-free: the gate run receives an injected source revision, so it never runs git.
  test('calls no GenerateFunction and runs no agent while it replays', async () => {
    const recordId = await gateRun();
    let generateCalls = 0;
    let agentRuns = 0;
    const spying: GateEvaluatorLoader = async (modulePath) => {
      const definition = await loadGateEvaluator(modulePath);
      const judge = definition.judge!;
      const spy: GenerateFunction = (context) => {
        generateCalls += 1;
        return judge(context);
      };
      return {
        ...definition,
        judge: spy,
        subject: (context) => {
          agentRuns += 1;
          return definition.subject(context);
        },
      };
    };

    const result = await runInProcess(
      ['--gate', FIXTURE_GATE_ID, '--latest', '--store', storePath],
      spying,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'match', recordId });
    expect(generateCalls).toBe(0);
    expect(agentRuns).toBe(0);
  });

  // spawn-free: the gate run receives an injected source revision, so it never runs git.
  test('replays a record by id and describes a mismatch on stderr', async () => {
    const recordId = await gateRun(fixtureGateFile('regressing'));
    const matched = await runInProcess([recordId, '--store', storePath]);
    expect(matched.exitCode).toBe(0);
    expect(JSON.parse(matched.stdout)).toMatchObject({ result: 'match', decision: 'regression' });
    expect(matched.stderr).toContain(`Replay of "${recordId}" matches: regression`);

    const tamperedId = `${recordId}-tampered`;
    await withHistory(async (history) => {
      const { record } = (await history.read(recordId)) as HistoricalRecord<GateDecisionRecord>;
      await history.append({ ...record, id: tamperedId, decision: 'pass' });
    });
    const mismatched = await runInProcess([tamperedId, '--store', storePath]);
    expect(mismatched.exitCode).toBe(4);
    expect(JSON.parse(mismatched.stdout)).toMatchObject({
      result: 'mismatch',
      differences: [{ path: 'decision' }],
    });
    expect(mismatched.stderr).toContain('first mismatching field "decision"');
  });

  // spawn-free: the gate run receives an injected source revision, so it never runs git.
  test('exits 4 for a decision its recorded evidence contradicts, naming the field', async () => {
    const recordId = await gateRun(fixtureGateFile('regressing'));
    const tamperedId = `${recordId}-tampered`;
    await withHistory(async (history) => {
      const { record } = (await history.read(recordId)) as HistoricalRecord<GateDecisionRecord>;
      await history.append({ ...record, id: tamperedId, decision: 'pass' });
    });

    const result = await runInProcess([tamperedId, '--store', storePath]);

    expect(result.exitCode).toBe(4);
    const report = JSON.parse(result.stdout) as { result: string; differences: unknown[] };
    expect(report.result).toBe('mismatch');
    expect(report.differences).toEqual([
      { path: 'decision', stored: 'pass', recomputed: 'regression' },
    ]);
    expect(result.stderr).toContain(
      'first mismatching field "decision": stored "pass", recomputed "regression"',
    );
  });

  // spawn-free: the gate run receives an injected source revision, so it never runs git.
  test('exits 3 when the recorded evaluator module can no longer be resolved', async () => {
    // The module never exists on disk: the gate run builds it from the passing
    // fixture, so replay's own import of the recorded path fails as a deleted
    // module does. Deleting a module this process had imported would not fail,
    // because the module cache would still serve it.
    const retired = join(directory, 'retired-evaluator.ts');
    const recordId = await gateRun(fixtureGateFile('passing', { evaluator: retired }), (path) =>
      loadGateEvaluator(path === retired ? evaluatorModule('passing') : path),
    );

    const result = await runInProcess([recordId, '--store', storePath]);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'unresolvable', recordId });
    expect(result.stderr).toContain('cannot be resolved');
  });

  // spawn-free: the gate run receives an injected source revision, so it never runs git.
  test('exits 64 for an unknown record and 65 for a corrupt one', async () => {
    const recordId = await gateRun();
    const unknown = await runInProcess(['never-recorded', '--store', storePath]);
    expect(unknown.exitCode).toBe(64);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ result: 'unknown-record' });

    await withHistory(async (_history, store) => {
      const key = `evaluation-history/records/${recordId}`;
      const text = (await store.get(key))!;
      await store.set(key, text.replace('"decision":"pass"', '"decision":"regression"'));
    });
    const corrupt = await runInProcess([recordId, '--store', storePath]);
    expect(corrupt.exitCode).toBe(65);
    expect(JSON.parse(corrupt.stdout)).toMatchObject({ result: 'corrupt-record', recordId });
    expect(corrupt.stderr).toContain('does not match its digest');
  });

  test.each([
    ['no record and no gate', []],
    ['both a record and a gate', ['some-record', '--gate', FIXTURE_GATE_ID, '--latest']],
    ['--latest without --gate', ['--latest']],
    ['--gate without --latest', ['--gate', FIXTURE_GATE_ID]],
    ['two records', ['one', 'two']],
    ['an unknown option', ['some-record', '--force']],
  ])('exits 64 with a usage report for %s', async (_label, args) => {
    const result = await runInProcess([...args, '--store', storePath]);
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'replay-report',
      result: 'usage-error',
    });
    expect(result.stderr).toContain('Usage: bun run --cwd testing/evaluation replay');
  });

  test('reads a store that does not exist as an empty history, without creating it', async () => {
    const result = await runInProcess([
      '--gate',
      FIXTURE_GATE_ID,
      '--latest',
      '--store',
      storePath,
    ]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('No gate decision for gate "fixture-regression"');
    expect(existsSync(storePath)).toBe(false);
  });
});
