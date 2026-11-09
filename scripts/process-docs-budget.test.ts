// Word budgets for the process documents, so they cannot regrow. Move mechanics, history, and
// rationale into `documentation/repository/` and link them, rather than raising a budget
// (documentation/repository/guards.md "Process documentation").

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const references = '.agents/skills/chef/references';

/** Words as `wc -w` counts them: runs of non-whitespace. */
function wordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => word !== '').length;
}

const wordsIn = (path: string) => wordCount(readFileSync(join(root, path), 'utf8'));

describe('process document word budgets', () => {
  test('count words the way wc -w does', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one\ttwo\n\nthree `four` | --- |  ')).toBe(7);
  });

  test('AGENTS.md stays within 3,800 words', () => {
    expect(wordsIn('AGENTS.md')).toBeLessThanOrEqual(3800);
  });

  test('.agents/skills/chef/SKILL.md stays within 3,000 words', () => {
    expect(wordsIn('.agents/skills/chef/SKILL.md')).toBeLessThanOrEqual(3000);
  });

  const referenceFiles = readdirSync(join(root, references))
    .filter((name) => name.endsWith('.md'))
    .toSorted();

  test('finds the chef reference documents', () => {
    expect(referenceFiles.length).toBeGreaterThan(0);
  });

  for (const name of referenceFiles) {
    test(`${references}/${name} stays within 3,000 words`, () => {
      expect(wordsIn(join(references, name))).toBeLessThanOrEqual(3000);
    });
  }
});
