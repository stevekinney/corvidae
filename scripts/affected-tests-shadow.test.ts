import { describe, expect, test } from 'bun:test';

import { omittedFailures } from './affected-tests-shadow.ts';

describe('shadow failure accounting', () => {
  test('records an attributable selected failure without an omission', () => {
    expect(
      omittedFailures(
        ['applications/interborough/src/host/remote-persistence-conformance.slow.test.ts'],
        ['remote-persistence-conformance.slow.test.ts:567 OAuth attempts'],
      ),
    ).toEqual([]);
  });

  test('reports a deliberately excluded attributable failure as an omission', () => {
    expect(
      omittedFailures([], ['remote-persistence-conformance.slow.test.ts:567 OAuth attempts']),
    ).toEqual(['remote-persistence-conformance.slow.test.ts:567 OAuth attempts']);
  });

  test('does not turn absent failure evidence into a miss', () => {
    expect(omittedFailures(['scripts/a.test.ts'], [])).toEqual([]);
  });
});
