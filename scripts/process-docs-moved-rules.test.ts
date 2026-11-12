// COR-2372 moved the rules only coordinators need out of AGENTS.md, which every session pays for on
// every request, into the chef references and `documentation/repository/`. Each entry names a
// rule's destination and a short phrase only that rule carries, so a later edit cannot drop a moved
// rule silently. The AGENTS.md entries are the clauses the first cut lost and a review restored.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const chef = '.agents/skills/chef/references';
const repository = 'documentation/repository';

/** Whitespace collapsed, so a rewrapped line still matches. */
const normalize = (text: string) => text.replace(/\s+/g, ' ');

const read = (path: string) => normalize(readFileSync(join(root, path), 'utf8'));

const movedRules: [rule: string, destination: string, phrase: string][] = [
  [
    'main health',
    `${chef}/program-runs.md`,
    '`merge-gate.ts` warns, and never refuses, while that run is red',
  ],
  [
    'fresh worker per issue',
    `${chef}/coordination.md`,
    'never keep one long-lived worker per stream',
  ],
  [
    'one full validate per session',
    `${chef}/coordination.md`,
    "An exception's full suite runs on GitHub, `gh workflow run main.yml --ref <branch>`, one at a time.",
  ],
  ['one review fix pass', `${chef}/coordination.md`, 'plus one review fix pass'],
  ['bots need not go quiet', `${chef}/coordination.md`, 'Do not wait for bots to go quiet'],
  ['economical model', `${chef}/coordination.md`, 'Implement with an economical coding model'],
  [
    'broadcasts',
    `${chef}/coordination.md`,
    'A broadcast to running sessions names the commit and the section that changed',
  ],
  ['owner-instruction waivers', `${chef}/coordination.md`, 'records the waived guard'],
  ['thin coordinator', `${chef}/coordination.md`, 'The coordinator is thin'],
  ['report spend', `${chef}/coordination.md`, 'When tokens per merged change double from the run'],
  ['lastCtx', `${chef}/coordination.md`, 'record `lastCtx` (`transcript-usage.ts`)'],
  [
    'review: sort by reversibility',
    `${repository}/review-and-parallel-run-history.md`,
    'ask whether the design paints the project into a corner',
  ],
  [
    'review: the diff, not the repository',
    `${repository}/review-and-parallel-run-history.md`,
    'cite the document and stop',
  ],
  [
    'review: Linear overlap check',
    `${repository}/review-and-parallel-run-history.md`,
    'do not claim there is no matching ticket or block solely on that lookup',
  ],
  [
    'review: breaking changes',
    `${repository}/review-and-parallel-run-history.md`,
    'remove deprecated code in the changed path',
  ],
  [
    'review: root causes',
    `${repository}/review-and-parallel-run-history.md`,
    'grep for its siblings',
  ],
  [
    'review: blocking',
    `${repository}/review-and-parallel-run-history.md`,
    'Touching a one-way door is not itself a blocker.',
  ],
  [
    'review: unanswered threads',
    `${repository}/review-and-parallel-run-history.md`,
    'An unanswered thread blocks the merge.',
  ],
  [
    'review: round mechanics',
    `${repository}/review-and-parallel-run-history.md`,
    'never push a fix for one thread while others from the same round are still open',
  ],
  [
    'review: prefer a guard',
    `${repository}/review-and-parallel-run-history.md`,
    'Prefer a guard to a comment',
  ],
  [
    'testing workspaces in devDependencies only',
    `${repository}/workspace-layout.md`,
    'may name only in `devDependencies`, never in `dependencies` or `peerDependencies`',
  ],
  [
    'plugin dependencies',
    `${repository}/workspace-layout.md`,
    'whose `dependencies` may name only that package',
  ],
  ['Svelte declarations', `${repository}/workspace-layout.md`, 'svelte2tsx'],
  [
    'typescript at the root',
    `${repository}/workspace-layout.md`,
    'Do not rely on a transitive or peer dependency to supply `tsc`.',
  ],
  [
    'file length and complexity',
    `${repository}/workspace-layout.md`,
    'Treat file length as review guidance, including in imported tests.',
  ],
  [
    'release intent',
    `${repository}/workspace-layout.md`,
    'Release intent for a batch backport is written in `stevekinney/corvidae-mirror`',
  ],
  ['.worktreeinclude', `${repository}/workspace-layout.md`, 'Do not add `.worktreeinclude`'],
  [
    'design-review detail',
    `${repository}/workspace-layout.md`,
    'a design programme closes only after a full drift audit',
  ],
  ['Bun per-test timeout', `${repository}/guards.md`, "Bun's per-test timeout is twice that"],
  [
    'task override restates transit',
    `${repository}/turborepo-stage-mechanics.md`,
    'must restate `"dependsOn": ["transit"]`',
  ],
  ['worker counts', `${repository}/turborepo-stage-mechanics.md`, '--parallel=4'],
  ['enforced correctness', 'AGENTS.md', 'Keep correctness, types, tests, and builds enforced.'],
  [
    'one deadline for everything check and validate run',
    'AGENTS.md',
    'Everything `bun run check` and `bun run validate` run has one deadline, the awake-time hang guard (`HANG_GUARD_MILLISECONDS`, 120 seconds), never a performance bound',
  ],
  ['out-of-scope behavior', 'AGENTS.md', 'cite the document and stop'],
  ['unanswered threads', 'AGENTS.md', 'An unanswered thread blocks the merge.'],
  ['one-way doors do not block', 'AGENTS.md', 'Touching a one-way door is not itself a blocker.'],
  ['nitpicks', 'AGENTS.md', 'omit nitpicks'],
  ['Linear lookup does not block', 'AGENTS.md', 'do not block solely on that lookup'],
];

describe('rules moved out of AGENTS.md', () => {
  for (const [rule, destination, phrase] of movedRules) {
    test(`${rule} stays in ${destination}`, () => {
      expect(read(destination)).toContain(normalize(phrase));
    });
  }
});
