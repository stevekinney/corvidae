/**
 * Identity is judged by pid plus the start time `ps` reports, so these read the real process table.
 * Each judgement runs at module scope, off Bun's per-test clock, and the tests assert on what it
 * recorded.
 */
import { expect, test } from 'bun:test';

import {
  isProcessGroupAlive,
  isSameProcess,
  processStartTime,
  processTableEnvironment,
} from './process-identity.ts';
import { judgeByProcess } from './reclaim.ts';

/** A pid no process holds: above any pid a supported host assigns. */
const unusedPid = 99_999_999;
const own = processStartTime(process.pid);
const sameProcess = isSameProcess(process.pid, own);
const reusedPid = isSameProcess(process.pid, 'an earlier incarnation of this pid');
const unrecorded = isSameProcess(process.pid, undefined);
const goneProcess = isSameProcess(unusedPid, 'Thu Jan  1 00:00:00 1970');
const goneStart = processStartTime(unusedPid);
const goneGroup = isProcessGroupAlive(unusedPid, undefined);
const base = { command: 'a command', cwd: '/a/worktree', acquiredAt: '', token: 't' };
const aliveRecord = judgeByProcess()({ ...base, pid: process.pid, pidStartedAt: own ?? '' });
const reusedRecord = judgeByProcess()({
  ...base,
  pid: process.pid,
  pidStartedAt: 'an earlier incarnation of this pid',
});
const deadRecord = judgeByProcess()({ ...base, pid: unusedPid });
const deadGroupRecord = judgeByProcess()({
  ...base,
  pid: unusedPid,
  processGroup: unusedPid,
});

test('reads this process’s start time through `ps` in the table environment', () => {
  expect(own).toBeString();
  expect(own).not.toBe('');
  expect(processTableEnvironment()['LC_ALL']).toBe('C');
  expect(goneStart).toBeUndefined();
});

test('takes a pid for the same process only while its recorded start time matches', () => {
  expect(sameProcess).toBe(true);
  expect(unrecorded).toBe(true);
  expect(reusedPid).toBe(false);
  expect(goneProcess).toBe(false);
});

test('finds no live member in a group nothing leads', () => {
  expect(goneGroup).toBe(false);
});

test('keeps a record alive while its own incarnation runs and in no other case', () => {
  expect(aliveRecord).toBe(true);
  expect(reusedRecord).toBe(false);
  expect(deadRecord).toBe(false);
  expect(deadGroupRecord).toBe(false);
});
