import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stubBrowserPublication } from './build-info.test-support.ts';
import {
  BUILD_INFO_FILE,
  displayedCommit,
  readBuildInfo,
  readSourceInfo,
  staleBuildProblem,
  UNKNOWN_COMMIT,
  type GitRunner,
} from './build-info.ts';
import { serveProblem } from './supervisor.ts';

const scratch = mkdtempSync(join(tmpdir(), 'build-info-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What a stand-in `git` answers: the commit of `HEAD`, the edits to tracked files, untracked names. */
type Checkout = { commit?: string; edits: string; untracked: string };

function fakeGit(checkout: Checkout): GitRunner {
  return (_directory, argumentsList) => {
    if (checkout.commit === undefined) return undefined;
    if (argumentsList[0] === 'rev-parse') return `${checkout.commit}\n`;
    if (argumentsList[0] === 'diff') return checkout.edits;
    return checkout.untracked;
  };
}

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const clean: Checkout = { commit: first, edits: '', untracked: '' };

/** A build directory with a publication record when given a source. */
function build(recorded?: Checkout): string {
  const directory = mkdtempSync(join(scratch, 'build-'));
  if (recorded !== undefined)
    stubBrowserPublication(directory, readSourceInfo('.', fakeGit(recorded)));
  return directory;
}

describe('staleBuildProblem', () => {
  // spawn-free: the git runner is a stand-in that answers from memory
  test('accepts a build made from the current commit of a clean tree', () => {
    expect(staleBuildProblem(build(clean), '.', fakeGit(clean))).toBeUndefined();
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a build whose recorded commit is not HEAD', () => {
    const problem = staleBuildProblem(build(clean), '.', fakeGit({ ...clean, commit: second }));
    expect(problem).toContain('was made from aaaaaaa but HEAD is bbbbbbb');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a clean build once the tree has uncommitted changes, and one of an old edit', () => {
    const edited = { ...clean, edits: 'diff one' };
    expect(staleBuildProblem(build(clean), '.', fakeGit(edited))).toContain('uncommitted changes');
    expect(staleBuildProblem(build(edited), '.', fakeGit(edited))).toBeUndefined();
    expect(
      staleBuildProblem(build(edited), '.', fakeGit({ ...clean, edits: 'diff two' })),
    ).toContain('uncommitted changes');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('counts an untracked file as a change', () => {
    const problem = staleBuildProblem(build(clean), '.', fakeGit({ ...clean, untracked: 'a.txt' }));
    expect(problem).toContain('uncommitted changes');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a build once an untracked file has been edited, though its name is unchanged', () => {
    const source = mkdtempSync(join(scratch, 'source-'));
    const file = join(source, 'new.txt');
    writeFileSync(file, 'one');
    const untracked = { ...clean, untracked: 'new.txt\n' };
    const git = fakeGit(untracked);
    const directory = mkdtempSync(join(scratch, 'build-'));
    stubBrowserPublication(directory, readSourceInfo(source, git));
    expect(serveProblem(directory, source, git)).toBeUndefined();
    writeFileSync(file, 'two');
    expect(serveProblem(directory, source, git)).toContain('uncommitted changes');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a build that records nothing, and one whose record is not a record', () => {
    const directory = build();
    expect(staleBuildProblem(directory, '.', fakeGit(clean))).toContain('records no source commit');
    writeFileSync(join(directory, BUILD_INFO_FILE), '[1]');
    expect(staleBuildProblem(directory, '.', fakeGit(clean))).toContain('records no source commit');
    writeFileSync(join(directory, BUILD_INFO_FILE), 'not json');
    expect(readBuildInfo(directory)).toBeUndefined();
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a build that recorded an unknown commit when the checkout knows its own', () => {
    expect(staleBuildProblem(build({ edits: '', untracked: '' }), '.', fakeGit(clean))).toContain(
      'was made from unknown',
    );
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('has nothing to compare in a directory with no Git history', () => {
    const none: Checkout = { edits: '', untracked: '' };
    expect(readSourceInfo('.', fakeGit(none)).commit).toBe(UNKNOWN_COMMIT);
    expect(staleBuildProblem(build(clean), '.', fakeGit(none))).toBeUndefined();
  });
});

describe('serveProblem', () => {
  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses to serve a build made from another commit, so `serve` exits nonzero', () => {
    const directory = build(clean);
    expect(serveProblem(directory, '.', fakeGit(clean))).toBeUndefined();
    const problem = serveProblem(directory, '.', fakeGit({ ...clean, commit: second }));
    expect(problem).toContain('Run `bun run build` first.');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('still names a build that is missing', () => {
    const directory = mkdtempSync(join(scratch, 'empty-'));
    expect(serveProblem(directory, '.', fakeGit(clean))).toContain('has not been built');
  });
});

describe('displayedCommit', () => {
  test('shows seven characters, marks an edited tree, and shows nothing for an unknown commit', () => {
    expect(displayedCommit({ commit: first, changes: '' })).toBe('aaaaaaa');
    expect(displayedCommit({ commit: first, changes: 'abc' })).toBe('aaaaaaa (edited)');
    expect(displayedCommit({ commit: UNKNOWN_COMMIT, changes: '' })).toBe('');
  });
});
