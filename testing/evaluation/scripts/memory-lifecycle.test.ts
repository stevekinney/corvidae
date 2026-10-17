import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '@lostgradient/testing';
import { artifactDigest } from '../src/memory-lifecycle/artifact';
import { BEST_SIMPLER_BASELINE_PATH } from '../src/memory-lifecycle/release';
import committedSuite from '../src/memory-lifecycle/suite.json';
import { runMemoryLifecycleCommand } from './memory-lifecycle';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'memory-lifecycle-command-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly document: Record<string, unknown>;
}

async function command(
  args: readonly string[],
  options: Parameters<typeof runMemoryLifecycleCommand>[1] = {},
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runMemoryLifecycleCommand(args, {
    ...options,
    output: {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    },
  });
  return { exitCode, stdout, stderr, document: JSON.parse(stdout) as Record<string, unknown> };
}

async function runLane(lane: string, ...extra: string[]): Promise<CommandResult> {
  return command(['run', '--lane', lane, '--artifacts-dir', join(directory, lane), ...extra]);
}

async function exitCodeOf(result: Promise<CommandResult>): Promise<number> {
  const { exitCode } = await result;
  return exitCode;
}

// Each lane runs hundreds of in-process trials (the stochastic lane about three seconds of CPU),
// which a loaded host stretches past Bun's five-second per-test clock. Every scenario that runs a
// lane, replays a scenario from it, or recomputes the baseline record runs here, once, at module
// scope, each in its own directory; its test rethrows the outcome. The replay tests read the
// artifacts the deterministic lane already wrote instead of running it again.
const laneDirectory = await mkdtemp(join(tmpdir(), 'memory-lifecycle-lanes-'));
afterAll(() => rm(laneDirectory, { recursive: true, force: true }));

async function runLaneIn(lane: string, ...extra: string[]): Promise<CommandResult> {
  return command(['run', '--lane', lane, '--artifacts-dir', join(laneDirectory, lane), ...extra]);
}

const deterministicLane = await outcomeOf(async () => {
  const report = join(laneDirectory, 'reports', 'deterministic.md');
  const result = await runLaneIn('deterministic', '--report', report);
  expect(result.exitCode).toBe(0);
  expect(result.document).toMatchObject({
    kind: 'memory-lifecycle-report',
    lane: 'deterministic',
    bestSimplerBaseline: 'raw-log-search',
    release: { decision: 'pass', exitCode: 0 },
    artifactsDirectory: join(laneDirectory, 'deterministic'),
  });
  const artifacts = await readdir(join(laneDirectory, 'deterministic'));
  const ablated = (
    result.document['components'] as { ablation: { artifacts: string[] } }[]
  ).flatMap((component) => component.ablation.artifacts);
  expect(ablated).toContain(
    'deterministic.lifecycle-without-procedure-memory.unverified-forum-procedure.1',
  );
  expect(artifacts).toHaveLength(4 * committedSuite.scenarios.length + ablated.length);
  for (const id of ablated) expect(artifacts).toContain(`${id}.json`);
  expect(await readFile(report, 'utf8')).toContain('## Release decision: pass (exit 0)');
  expect(result.stderr).toContain('memory-lifecycle deterministic: pass against raw-log-search');
});

const stochasticLane = await outcomeOf(async () => {
  const result = await runLaneIn('stochastic', '--seed', 'recorded');
  expect(result.exitCode).toBe(0);
  expect(result.document).toMatchObject({ lane: 'stochastic', seed: 'recorded', repetitions: 5 });
  // Each promotion is attributed by the component's own ablation, not by the rest of the architecture.
  const components = result.document['components'] as {
    component: string;
    promoted: boolean;
    measures: { lifecycle: number; withoutComponent: number }[];
  }[];
  for (const component of components) {
    expect(component.promoted).toBe(true);
    expect(component.measures.some((measure) => measure.lifecycle > measure.withoutComponent)).toBe(
      true,
    );
  }
});

const suiteFromFile = await outcomeOf(async () => {
  const suitePath = join(laneDirectory, 'suite.json');
  await writeFile(suitePath, JSON.stringify(committedSuite));
  const exitCode = await exitCodeOf(
    command([
      'run',
      '--lane',
      'deterministic',
      '--artifacts-dir',
      join(laneDirectory, 'from-file'),
      '--suite',
      suitePath,
    ]),
  );
  expect(exitCode).toBe(0);
});

const baselineRecord = await outcomeOf(async () => {
  const current = await command(['baseline']);
  expect(current.exitCode).toBe(0);
  expect(current.document).toMatchObject({ result: 'current', differences: [] });

  const copy = join(laneDirectory, 'baseline.json');
  await copyFile(BEST_SIMPLER_BASELINE_PATH, copy);
  const stale = JSON.parse(await readFile(copy, 'utf8')) as Record<string, unknown>;
  await writeFile(copy, JSON.stringify({ ...stale, latencyMilliseconds: 5 }));
  const outdated = await command(['baseline'], { baselinePath: copy });
  expect(outdated.exitCode).toBe(1);
  expect(outdated.document).toMatchObject({
    result: 'stale',
    differences: [{ path: 'latencyMilliseconds', stored: 5, recomputed: 0 }],
  });
  expect(outdated.stderr).toContain('is stale; regenerate it with --write');

  const written = await command(['baseline', '--write'], { baselinePath: copy });
  expect(written.exitCode).toBe(0);
  expect(await readFile(copy, 'utf8')).toBe(await readFile(BEST_SIMPLER_BASELINE_PATH, 'utf8'));
});

describe('memory-lifecycle run', () => {
  test('runs the deterministic lane, writes every artifact and the Markdown report, and exits with the decision', () =>
    rethrow(deterministicLane));

  test('runs the stochastic lane with a fixed, recorded seed', () => rethrow(stochasticLane));

  test('runs a suite from a file, and refuses one that is missing, not JSON, or invalid', async () => {
    rethrow(suiteFromFile);
    const suitePath = join(directory, 'suite.json');

    const missing = await runLane('deterministic', '--suite', join(directory, 'absent.json'));
    expect(missing.exitCode).toBe(64);
    expect(missing.document).toMatchObject({ kind: 'memory-lifecycle-usage-error' });

    await writeFile(suitePath, 'not json');
    expect(await exitCodeOf(runLane('deterministic', '--suite', suitePath))).toBe(64);

    await writeFile(suitePath, JSON.stringify({ ...committedSuite, scenarios: [] }));
    const invalid = await runLane('deterministic', '--suite', suitePath);
    expect(invalid.exitCode).toBe(64);
    expect(invalid.document).toMatchObject({
      kind: 'memory-lifecycle-configuration-error',
      issues: [{ path: ['scenarios'] }],
    });
  });

  test('refuses an unknown lane, a stray argument, an unknown option, and no subcommand', async () => {
    for (const args of [
      ['run', '--lane', 'live'],
      ['run', 'extra'],
      ['run', '--retries', '3'],
      [],
      ['publish'],
    ]) {
      const result = await command(args);
      expect(result.exitCode).toBe(64);
      expect(result.document).toMatchObject({ kind: 'memory-lifecycle-usage-error' });
      expect(result.stderr).toContain('Usage: bun run --cwd testing/evaluation memory-lifecycle');
    }
  });
});

describe('memory-lifecycle replay', () => {
  test('replays one failure from its artifact without a model', async () => {
    const artifact = join(
      laneDirectory,
      'deterministic',
      'deterministic.flat-hybrid.shared-agent-phone.1.json',
    );
    const result = await command(['replay', artifact]);
    expect(result.exitCode).toBe(0);
    expect(result.document).toMatchObject({
      kind: 'memory-lifecycle-replay',
      result: 'match',
      artifactId: 'deterministic.flat-hybrid.shared-agent-phone.1',
    });
    expect(result.stderr).toContain('matches');

    const suitePath = join(directory, 'suite.json');
    await writeFile(suitePath, JSON.stringify(committedSuite));
    expect(await exitCodeOf(command(['replay', artifact, '--suite', suitePath]))).toBe(0);
    await writeFile(suitePath, JSON.stringify({ ...committedSuite, scenarios: [] }));
    expect(await exitCodeOf(command(['replay', artifact, '--suite', suitePath]))).toBe(64);
  });

  test('exits 4 on a mismatch, 3 when unresolvable, 65 on a corrupt artifact, and 64 on a usage error', async () => {
    const path = join(
      laneDirectory,
      'deterministic',
      'deterministic.lifecycle.forgotten-phone.1.json',
    );
    const artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const forged = join(directory, 'forged.json');

    const { digest: _digest, ...unsigned } = artifact;
    const exchanges = (
      unsigned['provider'] as { exchanges: { toolCalls: { arguments: unknown }[] }[] }
    ).exchanges;
    exchanges[1]!.toolCalls[0]!.arguments = { action: 'call_customer', value: '503-555-0142' };
    await writeFile(
      forged,
      JSON.stringify({ ...unsigned, digest: await artifactDigest(unsigned as never) }),
    );
    const mismatch = await command(['replay', forged]);
    expect(mismatch.exitCode).toBe(4);
    expect(mismatch.stderr).toContain('does not match; first mismatching field');

    const renamed = { ...unsigned, scenario: { ...(unsigned['scenario'] as object), id: 'gone' } };
    await writeFile(
      forged,
      JSON.stringify({ ...renamed, digest: await artifactDigest(renamed as never) }),
    );
    expect(await exitCodeOf(command(['replay', forged]))).toBe(3);

    await writeFile(forged, JSON.stringify({ ...artifact, seed: 0 }));
    expect(await exitCodeOf(command(['replay', forged]))).toBe(65);
    await writeFile(forged, '{');
    const notJson = await command(['replay', forged]);
    expect(notJson.exitCode).toBe(65);
    expect(notJson.document).toMatchObject({ result: 'corrupt-artifact' });

    expect(await exitCodeOf(command(['replay', join(directory, 'absent.json')]))).toBe(64);
    expect(await exitCodeOf(command(['replay']))).toBe(64);
  });
});

describe('memory-lifecycle baseline', () => {
  test('confirms the committed record is current, reports a stale one, and writes a fresh one', async () => {
    rethrow(baselineRecord);
    expect(await exitCodeOf(command(['baseline', 'extra']))).toBe(64);
  });
});

// The real process is the behavior under test: that the package script is wired to the entry point
// and that `process.exitCode` reaches the shell. A usage error proves both at the cost of one
// `bun` boot, with no suite load and no run. The release decision and every other exit code are
// asserted in process above, so nothing here repeats a lane. The spawn runs once at module scope
// to stay off the per-test clock.
const spawnedUsageError = await (async () => {
  const child = spawnWithHangGuard(
    [process.execPath, 'run', '--cwd', PACKAGE_DIRECTORY, 'memory-lifecycle', 'publish'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
})();

describe('the memory-lifecycle script', () => {
  test('runs as a package script and exits 64 on a usage error', () => {
    expect(spawnedUsageError.exitCode).toBe(64);
    expect(JSON.parse(spawnedUsageError.stdout)).toMatchObject({
      kind: 'memory-lifecycle-usage-error',
    });
    expect(spawnedUsageError.stderr).toContain(
      'Usage: bun run --cwd testing/evaluation memory-lifecycle',
    );
  });
});
