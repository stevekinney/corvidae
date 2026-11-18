import { describe, expect, test } from 'bun:test';

import { omittedFailures, replayRevision } from './affected-tests-shadow.ts';

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

  test('replays a revision through the supported entrypoint without a stale selection reference', () => {
    const replay = replayRevision(process.cwd(), {
      name: 'entrypoint control',
      revision: '5888509145ffe2884eced68e8ca11f71c1d16e06',
      base: '5888509145ffe2884eced68e8ca11f71c1d16e06',
      provider: { jobs: [] },
    });
    expect(replay.changed).toEqual([]);
    expect(replay.selected).toEqual([]);
    expect(replay.omittedFailures).toEqual([]);
  });
});
