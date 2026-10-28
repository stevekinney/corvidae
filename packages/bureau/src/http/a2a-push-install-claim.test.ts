/**
 * Guard for the repeating receipt-mismatch class (#507): the install a send owes is decided at
 * admission and recorded in its claim, and completion is impossible while it is owed and not done.
 */
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { completeSend, owedInstallOf, type OwedInstallInput } from './a2a-push-install-claim.ts';

const base: OwedInstallInput = {
  hasInline: true,
  continuing: false,
  expired: false,
  pending: undefined,
  tail: undefined,
};

describe('the install a send owes', () => {
  const paths: Array<{
    name: string;
    input: OwedInstallInput;
    expected: ReturnType<typeof owedInstallOf>;
  }> = [
    {
      name: 'a send without a configuration',
      input: { ...base, hasInline: false },
      expected: undefined,
    },
    { name: 'a new task', input: base, expected: { pushOwed: true, pushCursor: '-1' } },
    {
      name: 'a continuation',
      input: { ...base, continuing: true, tail: '7' },
      expected: { pushOwed: true, pushCursor: '7' },
    },
    {
      name: 'a continuation of a task with no history',
      input: { ...base, continuing: true },
      expected: { pushOwed: true, pushCursor: '-1' },
    },
    {
      name: 'a new task past its deadline',
      input: { ...base, expired: true },
      expected: { pushOwed: true, pushCursor: '-1' },
    },
    {
      name: 'a continuation past its deadline, which applies no input',
      input: { ...base, continuing: true, expired: true, tail: '7' },
      expected: { pushOwed: false, pushCursor: '7' },
    },
    {
      name: 'a retry after a crash before the install, whatever the task became',
      input: {
        ...base,
        continuing: true,
        expired: true,
        tail: '99',
        pending: { pushOwed: true, pushCursor: '-1' },
      },
      expected: { pushOwed: true, pushCursor: '-1' },
    },
  ];

  for (const path of paths) {
    it(`is recorded for ${path.name}`, () => {
      expect(owedInstallOf(path.input)).toEqual(path.expected);
    });
  }

  it('cannot complete while the install is owed and not confirmed', async () => {
    const completed: string[] = [];
    const ledger = {
      complete: async (_entry: string, result: string) => void completed.push(result),
    };

    const refusal = await rejectionOf(
      completeSend(ledger, 'entry', 'result', { pushOwed: true, pushCursor: '-1' }, false),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('cannot complete');
    expect(completed).toEqual([]);

    await completeSend(ledger, 'entry', 'installed', { pushOwed: true, pushCursor: '-1' }, true);
    await completeSend(ledger, 'entry', 'not owed', { pushOwed: false, pushCursor: '-1' }, false);
    await completeSend(ledger, 'entry', 'no configuration', undefined, false);
    expect(completed).toEqual(['installed', 'not owed', 'no configuration']);
  });
});
