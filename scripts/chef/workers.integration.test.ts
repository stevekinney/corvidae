import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { parseLiveWorkers, run, UsageError } from './workers.ts';

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runWithHangGuard([
    'git',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    '-C',
    directory,
    ...args,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

// The fixture is a bare origin and a clone on a pushed branch with one unpushed commit and one
// uncommitted file. It is built at module scope so each process runs under the hang guard.
const sandbox = mkdtempSync(join(tmpdir(), 'workers-'));
const origin = join(sandbox, 'origin.git');
const clone = join(sandbox, 'clone');
await git(sandbox, 'init', '--bare', '--initial-branch=main', origin);
await git(sandbox, 'clone', origin, clone);
await git(clone, 'commit', '--allow-empty', '-m', 'base');
await git(clone, 'push', 'origin', 'HEAD:main');
await git(clone, 'checkout', '-b', 'chef/work');
writeFileSync(join(clone, 'pushed.txt'), 'pushed');
await git(clone, 'add', '.');
await git(clone, 'commit', '-m', 'pushed');
await git(clone, 'push', 'origin', 'chef/work');
writeFileSync(join(clone, 'local.txt'), 'local');
await git(clone, 'add', '.');
await git(clone, 'commit', '-m', 'local');
writeFileSync(join(clone, 'dirty.txt'), 'dirty');

const transcript = join(sandbox, 'transcript.jsonl');
writeFileSync(transcript, '{}');
const stale = new Date(Date.now() - 60 * 60 * 1000);
utimesSync(transcript, stale, stale);

const log = join(sandbox, 'run-log.md');
writeFileSync(
  log,
  `worker-start agent=a1 issue=COR-9 worktree=${clone} branch=chef/work transcript=${transcript}\n`,
);

const statusBefore = await git(clone, 'status', '--porcelain=v2', '--branch');
const worktreesBefore = await git(clone, 'worktree', 'list', '--porcelain');
const result = run([log, '--json']);
const text = run([log]);
const statusAfter = await git(clone, 'status', '--porcelain=v2', '--branch');
const worktreesAfter = await git(clone, 'worktree', 'list', '--porcelain');

describe('parseLiveWorkers', () => {
  test('keeps a started worker until its end entry and ignores other lines', () => {
    const entries = [
      '10:00 worker-start agent=a1 issue=COR-1 worktree=/w/one branch=chef/one',
      '10:01 worker-start agent=a2 issue=COR-2 worktree=/w/two branch=chef/two transcript=/t/two.jsonl',
      '10:02 something else',
      '10:30 worker-end agent=a1',
    ].join('\n');
    expect(parseLiveWorkers(entries)).toEqual([
      {
        agent: 'a2',
        issue: 'COR-2',
        worktree: '/w/two',
        branch: 'chef/two',
        transcript: '/t/two.jsonl',
      },
    ]);
  });
});

describe('the restart check', () => {
  test('counts one unpushed commit and one uncommitted file, and changes nothing', () => {
    const [state] = JSON.parse(result.output) as {
      unpushed: number;
      uncommitted: number;
      transcriptGrew: boolean;
      lastCommit: string;
      against: string;
    }[];
    expect(result.code).toBe(1);
    expect(state?.unpushed).toBe(1);
    expect(state?.uncommitted).toBe(1);
    expect(state?.against).toBe('origin/chef/work');
    expect(state?.transcriptGrew).toBe(false);
    expect(state?.lastCommit).toMatch(/^\d{4}-/);
    expect(text.output).toContain('unpushed commits: 1');
    expect(statusAfter).toBe(statusBefore);
    expect(worktreesAfter).toBe(worktreesBefore);
  });

  test('reports a missing worktree and rejects a missing log', () => {
    const missing = join(sandbox, 'missing-log.md');
    writeFileSync(missing, 'worker-start agent=a1 issue=COR-9 worktree=/nope branch=chef/x\n');
    const report = run([missing]);
    expect(report.code).toBe(1);
    expect(report.output).toContain('the worktree does not exist');
    expect(() => run([join(sandbox, 'absent.md')])).toThrow(UsageError);
    rmSync(sandbox, { recursive: true, force: true });
  });
});
