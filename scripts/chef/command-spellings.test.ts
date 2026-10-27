import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { charterRules, run as runBrief } from './brief.ts';
import {
  flagProblemsIn,
  invocationsIn,
  paragraphsOf,
  problemWith,
  spellingProblems,
  usageStatements,
} from './command-spellings.test-support.ts';
import { run as runLinear } from './linear.ts';
import { run as runNote } from './note.ts';
import { run as runReviewThreads } from './review-threads.ts';
import { parseCommandLine } from './worktree-scope.ts';

const repositoryRoot = join(import.meta.dir, '../..');
const skillFiles = [
  '.agents/skills/chef/references/execution-record.md',
  '.agents/skills/chef/SKILL.md',
];

const minimumInvocations: Record<string, number> = {
  '.agents/skills/chef/references/execution-record.md': 8,
  '.agents/skills/chef/SKILL.md': 4,
};

describe('the spelling checker', () => {
  test('reads each subcommand and its options from a script header', () => {
    const statements = usageStatements('review-threads');
    const list = statements.filter((statement) => statement.subcommand === 'list');
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((statement) => statement.options.has('--pr'))).toBe(true);
    expect(usageStatements('worktree-scope').some((s) => s.options.has('--capture'))).toBe(true);
  });

  test('accepts the spellings the scripts take', () => {
    for (const span of [
      'bun scripts/chef/review-threads.ts list --pr <n>',
      'bun scripts/chef/review-threads.ts list <owner/repo> <pr> --unresolved',
      'bun scripts/chef/review-threads.ts classes --pr <n>',
      'bun scripts/chef/worktree-scope.ts verify --capture <json>',
      'bun scripts/chef/worktree-scope.ts verify --configuration <json> --before <json>',
      'bun scripts/chef/linear.ts read <ID> --json',
      'bun scripts/chef/note.ts row <note> --key <k> --column <c> --value <v>',
      'scripts/chef/leftovers.ts',
    ]) {
      expect(spellingProblems(`Run \`${span}\` now.`), span).toEqual([]);
    }
  });

  test('flags the spellings workers and coordinators guessed', () => {
    const guesses: [string, RegExp][] = [
      [
        'bun scripts/chef/worktree-scope.ts verify --worktree <dir> --baseline <json>',
        /--worktree/,
      ],
      ['bun scripts/chef/review-threads.ts list --repo <r> --pr <n>', /--repo/],
      ['bun scripts/chef/review-threads.ts show --pr <n>', /unknown subcommand show/],
      ['bun scripts/chef/linear.ts read <ID> --description', /--description/],
      ['bun scripts/chef/review-threads.ts', /no subcommand/],
      ['bun scripts/chef/nonexistent.ts run', /does not exist/],
      ['bun scripts/chef/note.ts state <n> --capture <j>', /--capture/],
    ];
    for (const [span, pattern] of guesses) {
      const problems = spellingProblems(`Run \`${span}\`.`);
      expect(problems.length, span).toBeGreaterThan(0);
      expect(problems.join('\n'), span).toMatch(pattern);
    }
  });

  test('reads a flag-only span against the scripts its paragraph names', () => {
    expect(flagProblemsIn('Use `bun scripts/chef/merge-gate.ts` with `--fixes-main`.')).toEqual([]);
    expect(
      flagProblemsIn('Use `bun scripts/chef/merge-gate.ts` with `--bogus-flag`.'),
    ).toHaveLength(1);
    expect(flagProblemsIn('No script here, so `--anything` is not checked.')).toEqual([]);
  });

  test('pairs backticks line by line, so a stray one cannot hide later invocations', () => {
    const found = invocationsIn(
      'an odd ` tick\nthen `bun scripts/chef/review-threads.ts classes --pr <n>` here',
    );
    expect(found.map((invocation) => invocation.script)).toEqual(['review-threads']);
    expect(found[0]?.tokens).toEqual(['classes', '--pr', '<n>']);
    expect(problemWith(found[0]!)).toBeUndefined();
  });
});

describe('Usage headers match the parsers of the scripts they document', () => {
  /** The message of the UsageError an attempt throws, or `undefined` when none is thrown. */
  async function usageMessage(attempt: () => unknown): Promise<string | undefined> {
    try {
      await attempt();
    } catch (error) {
      if (error instanceof Error && error.constructor.name === 'UsageError') return error.message;
    }
    return undefined;
  }

  const failingRunner = () => ({ code: 1, stdout: '', stderr: 'offline' });
  const noNetwork = {
    environment: { LINEAR_API_KEY: 'lin_api_test_value' },
    fetch: async () => new Response('{}', { status: 500 }),
  };
  const parsers: Record<string, (subcommand: string | undefined, argv: string[]) => unknown> = {
    'review-threads': (subcommand, argv) =>
      runReviewThreads([subcommand!, '--pr', '7', '--repository', 'a/b', ...argv], {
        runner: failingRunner,
      }),
    'worktree-scope': (subcommand, argv) => parseCommandLine([subcommand!, ...argv]),
    note: (subcommand, argv) => runNote([subcommand!, 'note.md', ...argv]),
    linear: (subcommand, argv) => runLinear([subcommand!, 'COR-1', ...argv], noNetwork),
    brief: (_subcommand, argv) => runBrief(['COR-1', ...argv], noNetwork),
  };

  for (const [script, parse] of Object.entries(parsers)) {
    test(`every option the ${script} header spells is one its parser accepts`, async () => {
      const unknown: string[] = [];
      for (const statement of usageStatements(script)) {
        for (const option of statement.options) {
          // A value option takes the next argument and a flag does not; whichever the parser
          // expects, the option must not be reported as unknown.
          for (const argv of [[option], [option, 'x']]) {
            const message = await usageMessage(() => parse(statement.subcommand, argv));
            if (message?.startsWith('Unknown option')) unknown.push(`${script} ${option}`);
          }
        }
      }
      expect(unknown).toEqual([]);
    });
  }

  test('the check notices an option the parser rejects', async () => {
    expect(
      await usageMessage(() => parsers['review-threads']!('list', ['--baseline', 'x'])),
    ).toStartWith('Unknown option');
  });
});

describe('chef command spellings', () => {
  test('every charter rule spells its chef commands the way the scripts accept them', () => {
    const problems = charterRules.flatMap((rule) => spellingProblems(rule));
    expect(problems).toEqual([]);
  });

  test('the charter names at least the commands workers run', () => {
    const named = new Set(
      charterRules.flatMap((rule) => invocationsIn(rule).map((invocation) => invocation.script)),
    );
    for (const script of ['gate-run', 'merge-gate', 'review-threads', 'leftovers'])
      expect(named.has(script), script).toBe(true);
  });

  for (const path of skillFiles) {
    test(`${path} spells its chef commands the way the scripts accept them`, () => {
      const text = readFileSync(join(repositoryRoot, path), 'utf8');
      // The floor catches an extraction that silently stopped finding invocations.
      expect(invocationsIn(text).length).toBeGreaterThanOrEqual(minimumInvocations[path]!);
      const problems = paragraphsOf(text).flatMap((paragraph) => spellingProblems(paragraph));
      expect(problems).toEqual([]);
    });
  }
});
