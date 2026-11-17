/**
 * `bureau.checks.list` as the browser reads it (COR-2113, COR-2114): what a read sends, and what it
 * refuses to read.
 */
import { throwingRejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { listChecks } from './bureau-checks.ts';
import { checkFixture } from './bureau-fixtures.test-support.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('a read of the checks', () => {
  test('asks for fifty results and sends only the filters it was given, with the cursor', async () => {
    stub = installBureauStub({ 'bureau.checks.list': () => ({ checks: [], nextCursor: null }) });

    await listChecks({}, undefined);
    await listChecks(
      {
        kind: 'scorer.recorded',
        checkId: 'tone@2',
        agentName: 'worker',
        outcome: 'fail',
        since: 1_000,
        until: 2_000,
      },
      'cursor-1',
      { limit: 7 },
    );

    expect(stub.calls.map((call) => call.params)).toEqual([
      { limit: 50 },
      {
        limit: 7,
        kind: 'scorer.recorded',
        checkId: 'tone@2',
        agentName: 'worker',
        outcome: 'fail',
        since: 1_000,
        until: 2_000,
        cursor: 'cursor-1',
      },
    ]);
    expect(stub.calls.every((call) => call.method === 'bureau.checks.list')).toBe(true);
  });

  test('parses every row and the cursor the answer hands back', async () => {
    const scored = checkFixture('s', { kind: 'scorer.recorded', checkId: 'tone@2', score: 0.82 });
    stub = installBureauStub({
      'bureau.checks.list': () => ({ checks: [checkFixture('a'), scored], nextCursor: 'next' }),
    });

    const page = await listChecks({}, undefined);

    expect(page.checks).toEqual([checkFixture('a'), scored]);
    expect(page.nextCursor).toBe('next');
  });

  test('refuses an answer with a kind or an outcome it does not know, or a row with no score field', async () => {
    for (const row of [
      { ...checkFixture('a'), kind: 'goal.attempt.failed' },
      { ...checkFixture('a'), outcome: 'passed' },
      Object.fromEntries(Object.entries(checkFixture('a')).filter(([key]) => key !== 'score')),
    ]) {
      stub?.restore();
      stub = installBureauStub({
        'bureau.checks.list': () => ({ checks: [row], nextCursor: null }),
      });
      const refused = await throwingRejectionOf(listChecks({}, undefined));
      expect(refused).toBeDefined();
    }
  });
});
