import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILD_INFO_FILE,
  displayedCommit,
  readBuildInfo,
  readSourceInfo,
  staleBuildProblem,
  UNKNOWN_COMMIT,
} from './build-info.ts';
import { serveProblem } from './supervisor.ts';

const scratch = mkdtempSync(join(tmpdir(), 'build-info-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(directory: string, ...command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: directory, stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A checkout with one commit, and an empty build directory beside it. */
function checkout(): { source: string; build: string } {
  const source = mkdtempSync(join(scratch, 'source-'));
  run(source, 'git', 'init', '--quiet');
  run(source, 'git', 'config', 'user.email', 'test@example.com');
  run(source, 'git', 'config', 'user.name', 'Test');
  run(source, 'git', 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'file.txt'), 'one');
  run(source, 'git', 'add', '.');
  run(source, 'git', 'commit', '--quiet', '-m', 'one');
  const build = mkdtempSync(join(scratch, 'build-'));
  writeFileSync(join(build, 'index.html'), 'page');
  return { source, build };
}

function record(build: string, source: string): void {
  writeFileSync(join(build, BUILD_INFO_FILE), JSON.stringify(readSourceInfo(source)));
}

describe('staleBuildProblem', () => {
  test('accepts a build made from the current commit of a clean tree', () => {
    const { source, build } = checkout();
    record(build, source);
    expect(staleBuildProblem(build, source)).toBeUndefined();
  });

  test('refuses a build whose recorded commit is not HEAD', () => {
    const { source, build } = checkout();
    record(build, source);
    writeFileSync(join(source, 'file.txt'), 'two');
    run(source, 'git', 'commit', '--quiet', '-am', 'two');
    const problem = staleBuildProblem(build, source);
    expect(problem).toContain('was made from');
    expect(problem).toContain(readSourceInfo(source).commit.slice(0, 7));
  });

  test('refuses a clean build once the tree has uncommitted changes, and one of an old edit', () => {
    const { source, build } = checkout();
    record(build, source);
    writeFileSync(join(source, 'file.txt'), 'edited');
    expect(staleBuildProblem(build, source)).toContain('uncommitted changes');
    record(build, source);
    expect(staleBuildProblem(build, source)).toBeUndefined();
    writeFileSync(join(source, 'file.txt'), 'edited again');
    expect(staleBuildProblem(build, source)).toContain('uncommitted changes');
  });

  test('counts an untracked file as a change', () => {
    const { source, build } = checkout();
    record(build, source);
    writeFileSync(join(source, 'new.txt'), 'new');
    expect(staleBuildProblem(build, source)).toContain('uncommitted changes');
  });

  test('refuses a build that records nothing, and one whose record is not a record', () => {
    const { source, build } = checkout();
    expect(staleBuildProblem(build, source)).toContain('records no source commit');
    writeFileSync(join(build, BUILD_INFO_FILE), '[1]');
    expect(staleBuildProblem(build, source)).toContain('records no source commit');
    writeFileSync(join(build, BUILD_INFO_FILE), 'not json');
    expect(readBuildInfo(build)).toBeUndefined();
  });

  test('has nothing to compare in a directory with no Git history', () => {
    const bare = mkdtempSync(join(scratch, 'bare-'));
    expect(readSourceInfo(bare).commit).toBe(UNKNOWN_COMMIT);
    expect(staleBuildProblem(bare, bare)).toBeUndefined();
  });
});

describe('serveProblem', () => {
  test('refuses to serve a build made from another commit, so `serve` exits nonzero', () => {
    const { source, build } = checkout();
    record(build, source);
    expect(serveProblem(build, source)).toBeUndefined();
    writeFileSync(join(source, 'file.txt'), 'two');
    run(source, 'git', 'commit', '--quiet', '-am', 'two');
    expect(serveProblem(build, source)).toContain('Run `bun run build` first.');
  });

  test('still names a build that is missing', () => {
    const { source } = checkout();
    const missing = join(scratch, 'missing');
    mkdirSync(missing);
    expect(serveProblem(missing, source)).toContain('has not been built');
  });
});

describe('displayedCommit', () => {
  test('shows seven characters, marks an edited tree, and shows nothing for an unknown commit', () => {
    const commit = 'a'.repeat(40);
    expect(displayedCommit({ commit, changes: '' })).toBe('aaaaaaa');
    expect(displayedCommit({ commit, changes: 'abc' })).toBe('aaaaaaa (edited)');
    expect(displayedCommit({ commit: UNKNOWN_COMMIT, changes: '' })).toBe('');
  });
});
