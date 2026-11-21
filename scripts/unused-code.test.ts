import { describe, expect, test } from 'bun:test';

import { findingsFromReport, unexpectedFindings } from './check-unused-code.ts';

describe('Knip baseline comparison', () => {
  test('preserves exact file, category, and symbol identities', () => {
    const report = findingsFromReport({
      issues: [
        {
          file: 'scripts/orphan.ts',
          files: [{ name: 'scripts/orphan.ts' }],
          exports: [{ name: 'run' }],
        },
      ],
    });
    expect(
      unexpectedFindings(report, [
        { category: 'files', file: 'scripts/orphan.ts', name: 'scripts/orphan.ts' },
      ]),
    ).toEqual([{ category: 'exports', file: 'scripts/orphan.ts', name: 'run' }]);
  });

  test('rejects malformed reporter output rather than treating it as an empty report', () => {
    expect(() =>
      findingsFromReport({ issues: [{ file: 'scripts/orphan.ts', files: [{}] }] }),
    ).toThrow('must name a symbol');
  });
});
