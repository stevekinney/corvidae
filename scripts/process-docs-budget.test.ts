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

  // Every session pays for AGENTS.md on every request, so it also has a character budget (COR-2372).
  test('AGENTS.md stays within 2,250 words and 16,000 characters', () => {
    expect(wordsIn('AGENTS.md')).toBeLessThanOrEqual(2250);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8').length).toBeLessThanOrEqual(16_000);
  });

  // The chef skill is the delivery sequence only (COR-2377).
  test('.agents/skills/chef/SKILL.md stays within 1,500 words', () => {
    expect(wordsIn('.agents/skills/chef/SKILL.md')).toBeLessThanOrEqual(1500);
  });

  // Each reference's budget is its size when COR-2377 shortened it, rounded up to the next 50.
  const referenceBudgets = new Map<string, number>([
    ['codex-protocol.md', 250],
    ['coordination.md', 950],
    ['credentials.md', 450],
    ['decisions.md', 400],
    ['defect-classes.md', 700],
    ['execution-record.md', 650],
    ['execution-report.md', 550],
    ['linear-policy.md', 1600],
    ['planning-and-routing.md', 950],
    ['program-runs.md', 950],
    ['review-and-deliver.md', 950],
  ]);

  const referenceFiles = readdirSync(join(root, references))
    .filter((name) => name.endsWith('.md'))
    .toSorted();

  test('gives every chef reference document a budget, and no budget to a missing one', () => {
    expect(referenceFiles).toEqual([...referenceBudgets.keys()].toSorted());
  });

  // The worker's checks and branch steps have one source, `charterRules` in `scripts/chef/brief.ts`.
  // A governed document that names both the focused-checks and the revert-check command restates
  // that sequence, and the copies drift: point at the brief's rule instead.
  const governedDocuments = [
    'AGENTS.md',
    '.claude/agents/chef-worker.md',
    '.codex/agents/chef-worker.toml',
    '.agents/skills/chef/SKILL.md',
    ...referenceFiles.map((name) => join(references, name)),
  ];

  for (const path of governedDocuments) {
    test(`${path} does not restate the focused-checks and revert-check sequence`, () => {
      const text = readFileSync(join(root, path), 'utf8');
      expect(text.includes('focused-checks.ts') && text.includes('revert-check.ts')).toBe(false);
    });
  }

  for (const [name, budget] of referenceBudgets) {
    test(`${references}/${name} stays within ${budget.toLocaleString('en-US')} words`, () => {
      expect(wordsIn(join(references, name))).toBeLessThanOrEqual(budget);
    });
  }
});
