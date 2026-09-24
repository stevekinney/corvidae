import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import type { DiffReviewState } from '../diff-review-state/index.js';
import {
  buildInterpolatingSourceLineMapFixture,
  buildRemovedTargetFixture,
  documentThreadsFixture,
  emptyAndTrailingNewlineFixture,
  emptyReviewFixture,
  maliciousContentFixture,
  markdownTargetsFixture,
  twoSourceTargetsFixture,
} from './diff-review-export-fixtures.js';
import type { DiffReviewExportOptions } from './diff-review-export-types.js';
import { exportDiffReviewJson, exportDiffReviewMarkdown } from './diff-review-export.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/diff-review');

function golden(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

/**
 * These checked-in fixtures are the byte-exact golden output for each scenario the contract
 * calls out (DR-5 acceptance): two source targets with repeated paths, a Markdown target with
 * old/new ranges and both normalized/raw coordinates, a review note, resolved/outdated
 * comments, an empty review, malicious-looking fenced/HTML text, empty/trailing-newline bodies,
 * an explicit unresolved-only scope, and existing document threads. A diff against the checked-in
 * file is a deliberate format change, not an incidental one — review it before updating the
 * fixture.
 */
const scenarios: Array<{
  name: string;
  state: DiffReviewState;
  options?: DiffReviewExportOptions;
}> = [
  { name: 'two-source-targets', state: twoSourceTargetsFixture },
  { name: 'markdown-targets', state: markdownTargetsFixture },
  { name: 'empty-review', state: emptyReviewFixture },
  { name: 'malicious-content', state: maliciousContentFixture },
  { name: 'empty-and-trailing-newline', state: emptyAndTrailingNewlineFixture },
  { name: 'unresolved-only', state: twoSourceTargetsFixture, options: { scope: 'unresolved' } },
  {
    name: 'with-document-threads',
    state: twoSourceTargetsFixture,
    options: { documentThreads: documentThreadsFixture },
  },
  { name: 'removed-target', state: buildRemovedTargetFixture() },
  { name: 'interpolating-source-line-map', state: buildInterpolatingSourceLineMapFixture() },
];

describe('DiffReview export golden fixtures', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name}.md is byte-identical to the checked-in fixture`, () => {
      const result = exportDiffReviewMarkdown(scenario.state, scenario.options);
      if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
      expect(result.value).toBe(golden(`${scenario.name}.md`));
    });

    test(`${scenario.name}.json is byte-identical to the checked-in fixture`, () => {
      const result = exportDiffReviewJson(scenario.state, scenario.options);
      if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
      expect(result.value).toBe(golden(`${scenario.name}.json`));
    });
  }

  test('running the same export twice reproduces the identical golden bytes both times', () => {
    const first = exportDiffReviewMarkdown(twoSourceTargetsFixture);
    const second = exportDiffReviewMarkdown(twoSourceTargetsFixture);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.value).toBe(golden('two-source-targets.md'));
    expect(second.value).toBe(golden('two-source-targets.md'));
  });
});
