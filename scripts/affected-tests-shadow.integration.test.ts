import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { normalizeJobLog, omittedFailures, replayRevision } from './affected-tests-shadow.ts';
import { failureRecords } from './chef/ci-compare.ts';

// The replay opens Git objects. Run that real process work at module scope so the test callback
// only asserts its recorded result, independent of the per-test clock.
const entrypointReplay = replayRevision(process.cwd(), {
  name: 'entrypoint control',
  revision: '5888509145ffe2884eced68e8ca11f71c1d16e06',
  base: '5888509145ffe2884eced68e8ca11f71c1d16e06',
  provider: { jobs: [] },
});

describe('shadow failure accounting', () => {
  test('normalizes the retained provider job log for the shared failure extractor', () => {
    const log = readFileSync(
      '/Users/stevekinney/Developer/corvidae/tmp/chef/2026-11-17-sdlc-14ef/p10/full-slow-failure.log',
      'utf8',
    );
    const identities = [
      ...failureRecords(normalizeJobLog('Slow and integration tests', log)).values(),
    ]
      .flatMap((records) => records)
      .flatMap((record) => (record.identity === undefined ? [] : [record.identity]));
    expect(identities.join('\n')).toContain('remote-persistence-conformance.slow.test.ts');
  });

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
    expect(entrypointReplay.changed).toEqual([]);
    expect(entrypointReplay.selected).toEqual([]);
    expect(entrypointReplay.omittedFailures).toEqual([]);
  });
});
