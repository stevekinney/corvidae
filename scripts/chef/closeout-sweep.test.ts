import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneScratch } from './closeout-sweep.ts';
import type { Runner } from './process-runner.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T12:00:00Z');

let checkout = '';
let scratch = '';

beforeEach(() => {
  checkout = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-sweep-')));
  scratch = join(checkout, 'tmp', 'chef', 'scratch');
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

/** A scratch directory whose every entry was last modified `ageDays` before `NOW`. */
function scratchDirectory(name: string, ageDays: number, nested = 'logs/run.log'): string {
  const directory = join(scratch, name);
  const file = join(directory, nested);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'log\n');
  const at = new Date(NOW - ageDays * DAY);
  for (const path of [file, join(file, '..'), directory]) utimesSync(path, at, at);
  return directory;
}

/** `lsof` answering that the given directories are some process's working directory. */
function lsofHolding(...directories: string[]): Runner {
  return (command) =>
    command[0] === 'lsof'
      ? {
          code: 0,
          stdout: directories.map((path, index) => `p${index + 100}\ncsh\nn${path}`).join('\n'),
          stderr: '',
        }
      : { code: 1, stdout: '', stderr: `unexpected ${command.join(' ')}` };
}

/** The state chef keeps beside its scratch, which no prune may touch. */
function writeState() {
  const chef = join(checkout, 'tmp', 'chef');
  for (const path of [
    'execution-state/execution-state.json',
    'execution-state/reports/old.json',
    'requests/delivery-old.json',
    'briefs/COR-1.md',
    'delivered-heads.log',
    '2026-11-01-run.md',
  ]) {
    mkdirSync(join(chef, path, '..'), { recursive: true });
    writeFileSync(join(chef, path), '{}\n');
    const old = new Date(NOW - 60 * DAY);
    utimesSync(join(chef, path), old, old);
  }
  return chef;
}

describe('pruneScratch', () => {
  test('removes scratch directories idle past the retention window', () => {
    const old = scratchDirectory('COR-1-aaaa', 10);
    const result = pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: lsofHolding() });
    expect(result.removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
  });

  test('keeps a directory with any entry modified inside the window, however deep', () => {
    const directory = scratchDirectory('COR-2-bbbb', 10);
    const deep = join(directory, 'node_modules', 'a', 'b', 'fresh.txt');
    mkdirSync(join(deep, '..'), { recursive: true });
    writeFileSync(deep, 'new\n');
    const result = pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: lsofHolding() });
    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual({ path: directory, reason: 'used within 7 days' });
    expect(existsSync(directory)).toBe(true);
  });

  test('keeps an idle directory a live process works in', () => {
    const directory = scratchDirectory('COR-3-cccc', 30);
    const result = pruneScratch({
      checkout,
      retentionDays: 7,
      now: NOW,
      runner: lsofHolding(join(directory, 'logs')),
    });
    expect(result.kept).toContainEqual({ path: directory, reason: 'a live process works in it' });
    expect(existsSync(directory)).toBe(true);
  });

  test('keeps everything when processes cannot be checked', () => {
    const directory = scratchDirectory('COR-4-dddd', 30);
    const failing: Runner = () => ({ code: 1, stdout: '', stderr: 'lsof failed' });
    const result = pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: failing });
    expect(result.removed).toEqual([]);
    expect(result.notes[0]).toContain('processes could not be checked');
    expect(existsSync(directory)).toBe(true);
  });

  test('a dry run reports what it would remove and removes nothing', () => {
    const old = scratchDirectory('COR-5-eeee', 10);
    const result = pruneScratch({
      checkout,
      retentionDays: 7,
      now: NOW,
      runner: lsofHolding(),
      dryRun: true,
    });
    expect(result.removed).toEqual([old]);
    expect(existsSync(old)).toBe(true);
  });

  test('never touches chef state outside the scratch directory, however old', () => {
    const chef = writeState();
    scratchDirectory('COR-6-ffff', 10);
    pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: lsofHolding() });
    for (const path of [
      'execution-state/execution-state.json',
      'execution-state/reports/old.json',
      'requests/delivery-old.json',
      'briefs/COR-1.md',
      'delivered-heads.log',
      '2026-11-01-run.md',
    ])
      expect(existsSync(join(chef, path))).toBe(true);
  });

  test('a missing scratch directory is nothing to prune', () => {
    rmSync(scratch, { recursive: true });
    const result = pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: lsofHolding() });
    expect(result).toEqual({ removed: [], kept: [], notes: [] });
  });

  test('a symbolic link inside scratch is judged by itself, never followed', () => {
    const outside = join(checkout, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'fresh.txt'), 'new\n');
    const directory = scratchDirectory('COR-7-gggg', 10);
    symlinkSync(outside, join(directory, 'link'));
    const at = new Date(NOW - 10 * DAY);
    lutimesSync(join(directory, 'link'), at, at);
    utimesSync(directory, at, at);
    const result = pruneScratch({ checkout, retentionDays: 7, now: NOW, runner: lsofHolding() });
    expect(result.removed).toEqual([directory]);
    expect(existsSync(join(outside, 'fresh.txt'))).toBe(true);
  });
});
