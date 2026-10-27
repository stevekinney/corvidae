import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishedGate } from './gate-child.test-support.ts';
import { runGate } from './gate-run.ts';
import {
  healthFilePath,
  lastRunOnMain,
  mainHealth,
  readHealth,
  recordBatchRun,
  recordFix,
  recordWaiver,
  renderMainHealth,
  resolveHealthFile,
} from './main-health.ts';
import type { Runner } from './process-runner.ts';

const sha = (character: string) => character.repeat(40);
const entry = (head: string, exitCode: number) => ({
  head,
  exitCode,
  time: '2026-10-23T00:00:00.000Z',
  command: 'bun run validate',
});

let sandbox: string;
let healthFile: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'main-health-'));
  healthFile = join(sandbox, 'tmp', 'chef', 'main-health.json');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A runner whose `git rev-list` prints `history`, newest first. */
const historyRunner =
  (history: string[], code = 0): Runner =>
  (command) =>
    command[1] === 'rev-list'
      ? { code, stdout: `${history.join('\n')}\n`, stderr: code === 0 ? '' : 'fatal' }
      : { code: 0, stdout: '', stderr: '' };

describe('the health file', () => {
  test('lives in the main checkout and tolerates a missing or corrupt file', () => {
    expect(healthFilePath('/repo')).toBe('/repo/tmp/chef/main-health.json');
    expect(readHealth(healthFile)).toEqual({ runs: [], fixes: [], waivers: [] });
    recordBatchRun(healthFile, entry(sha('a'), 0));
    writeFileSync(healthFile, '{not json');
    expect(readHealth(healthFile)).toEqual({ runs: [], fixes: [], waivers: [] });
    writeFileSync(
      healthFile,
      JSON.stringify({ runs: [entry(sha('a'), 1), { head: 3 }], fixes: 7 }),
    );
    expect(readHealth(healthFile).runs).toEqual([entry(sha('a'), 1)]);
  });

  test('appends runs and fixes and keeps the newest 50 runs', () => {
    for (let index = 0; index < 55; index += 1) recordBatchRun(healthFile, entry(`${index}`, 0));
    recordFix(healthFile, { pr: 9, time: 't', blockedHead: sha('b') });
    const health = readHealth(healthFile);
    expect(health.runs).toHaveLength(50);
    expect(health.runs[0]?.head).toBe('5');
    expect(health.fixes).toEqual([{ pr: 9, time: 't', blockedHead: sha('b') }]);
    expect(existsSync(`${healthFile}.${process.pid}.tmp`)).toBe(false);
  });

  test('keeps waivers apart from fixes, and drops a waiver without its reason', () => {
    const waiver = {
      pr: 10,
      time: 't',
      blockedHead: sha('b'),
      reason: 'a load flake that passes alone',
      controlHead: sha('c'),
    };
    recordFix(healthFile, { pr: 9, time: 't', blockedHead: sha('b') });
    recordWaiver(healthFile, waiver);
    expect(readHealth(healthFile)).toEqual({
      runs: [],
      fixes: [{ pr: 9, time: 't', blockedHead: sha('b') }],
      waivers: [waiver],
    });
    // A waiver from `--waive-main-health` names no control head; a record with no reason is dropped.
    const unconditional = { pr: 11, time: 't', blockedHead: sha('b'), reason: 'main was red' };
    writeFileSync(
      healthFile,
      JSON.stringify({
        waivers: [waiver, unconditional, { pr: 12, time: 't', blockedHead: sha('b') }],
      }),
    );
    expect(readHealth(healthFile).waivers).toEqual([waiver, unconditional]);
  });

  test('resolveHealthFile asks Git for the main checkout, and is undefined when it cannot', () => {
    const runner: Runner = () => ({ code: 0, stdout: '/repo/.git\n', stderr: '' });
    expect(resolveHealthFile(runner, '/repo/wt')).toBe('/repo/tmp/chef/main-health.json');
    const broken: Runner = () => ({ code: 128, stdout: '', stderr: 'not a repository' });
    expect(resolveHealthFile(broken, '/nowhere')).toBeUndefined();
  });
});

describe('lastRunOnMain', () => {
  test('ignores heads that are not on main and takes the one nearest the tip', () => {
    const history = [sha('3'), sha('2'), sha('1')];
    const runs = [entry(sha('1'), 1), entry(sha('9'), 1), entry(sha('2'), 0)];
    expect(lastRunOnMain(runs, history)?.head).toBe(sha('2'));
    expect(lastRunOnMain([entry(sha('9'), 1)], history)).toBeUndefined();
  });
});

describe('mainHealth', () => {
  test('is green with no record, and red when the last batch on main failed', () => {
    const history = [sha('3'), sha('2'), sha('1')];
    expect(mainHealth(historyRunner(history), sandbox, 'main', healthFile).red).toBe(false);
    recordBatchRun(healthFile, entry(sha('1'), 0));
    recordBatchRun(healthFile, entry(sha('2'), 1));
    const red = mainHealth(historyRunner(history), sandbox, 'main', healthFile);
    expect(red.red).toBe(true);
    expect(renderMainHealth(red, 'main')).toContain('RED');
  });

  test('a later green validate clears an earlier red one, and a failure off main does not count', () => {
    const history = [sha('3'), sha('2'), sha('1')];
    recordBatchRun(healthFile, entry(sha('2'), 1));
    recordBatchRun(healthFile, entry(sha('3'), 0));
    recordBatchRun(healthFile, entry(sha('9'), 1));
    expect(mainHealth(historyRunner(history), sandbox, 'main', healthFile).red).toBe(false);
  });

  test('reports the fixes and waivers recorded against the failing head, apart from each other', () => {
    const history = [sha('3'), sha('2'), sha('1')];
    recordBatchRun(healthFile, entry(sha('2'), 1));
    recordFix(healthFile, { pr: 21, time: 't', blockedHead: sha('2') });
    recordWaiver(healthFile, {
      pr: 22,
      time: 't',
      blockedHead: sha('2'),
      reason: 'a fixture this change does not touch',
    });
    recordWaiver(healthFile, { pr: 23, time: 't', blockedHead: sha('1'), reason: 'older head' });
    const health = mainHealth(historyRunner(history), sandbox, 'main', healthFile);
    expect(health.fixes.map((fix) => fix.pr)).toEqual([21]);
    expect(health.waivers.map((waiver) => waiver.pr)).toEqual([22]);
    const text = renderMainHealth(health, 'main');
    expect(text).toContain('fixes: PR #21');
    expect(text).toContain('waivers: PR #22 (a fixture this change does not touch)');
    expect(text).not.toContain('#23');
    // A healthy main with nothing recorded against it prints no extra lines.
    expect(
      renderMainHealth(
        mainHealth(historyRunner(history), sandbox, 'main', join(sandbox, 'x')),
        'main',
      ),
    ).not.toContain('waivers');
  });

  test('is not red when main history cannot be listed, and says why', () => {
    recordBatchRun(healthFile, entry(sha('2'), 1));
    const health = mainHealth(historyRunner([], 128), sandbox, 'main', healthFile);
    expect(health.red).toBe(false);
    expect(renderMainHealth(health, 'main')).toContain('unknown');
  });
});

describe('gate-run records the batch validate', () => {
  async function runWith(command: string, exitCode: number) {
    const configPath = join(sandbox, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'o/n',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'n',
        installCommand: 'true',
        gateCommand: 'bun run check',
        affectedCheckCommand: 'bun run check',
        batchCommand: 'bun run validate',
        mergeMethod: 'squash',
      }),
    );
    const runner: Runner = (argv) => {
      if (argv[1] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: `${sha('a')}\n`, stderr: '' };
    };
    await runGate(
      { configPath, worktree: sandbox, log: join(sandbox, 'gate.log'), command, healthFile },
      {
        runner,
        load: () => 1,
        now: () => new Date('2026-10-23T01:02:03.000Z'),
        spawnGate: () => finishedGate(exitCode),
      },
    );
  }

  test('writes head, exit code and time for the batch command', async () => {
    await runWith('bun run validate', 3);
    expect(JSON.parse(readFileSync(healthFile, 'utf8')).runs).toEqual([
      {
        head: sha('a'),
        exitCode: 3,
        time: '2026-10-23T01:02:03.000Z',
        command: 'bun run validate',
      },
    ]);
  });

  test('records nothing for the per-pull-request check or any other command', async () => {
    await runWith('bun run check', 0);
    await runWith('echo hi', 0);
    expect(existsSync(healthFile)).toBe(false);
  });
});
