import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  blockerLines,
  charterRules,
  deliveryRule,
  designLinks,
  designRowIds,
  pathsIn,
  renderBrief,
  rowCarriage,
  run,
  sectionOf,
  stripShared,
  verificationCommands,
} from './brief.ts';
import type { FetchLike, IssueSummary } from './linear.ts';
import { UsageError } from './process-runner.ts';

const description = [
  'Some intro.',
  '',
  '## Execution brief',
  'Add the thing in `scripts/chef/thing.ts` and test it.',
  '### Detail',
  'Nested text stays in the section.',
  '',
  '## Acceptance criteria',
  '- It works.',
  '- It is tested.',
  '',
  '## Files',
  '- `scripts/chef/thing.ts:12`',
  '- `scripts/chef/thing.test.ts`',
  '- `not-a-path`',
  '',
  '## Notes',
  'Ignore me.',
].join('\n');

const issue = (text: string | null): IssueSummary => ({
  id: 'u1',
  identifier: 'COR-7',
  title: 'Add the thing',
  description: text,
  updatedAt: '2026-10-23T00:00:00Z',
  state: { id: 's', name: 'Todo' },
  team: { id: 't', key: 'COR', parent: null },
});

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'brief-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('designRowIds and designLinks', () => {
  test('finds bold row IDs and leading row IDs, once each, in order', () => {
    expect(
      designRowIds('* **11a** (Chat): x\n* **12a** (Chat): y\n- 04f: z\n* **11a** again'),
    ).toEqual(['11a', '12a', '04f']);
  });

  test('finds claude.ai artifact links once each', () => {
    const text =
      'See [canvas](https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw) and <https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw>.';
    expect(designLinks(text)).toEqual(['https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw']);
  });
});

describe('rowCarriage', () => {
  test('a dated revision moves rows in and out, in order', () => {
    const body = [
      '## Acceptance criteria',
      '- [ ] 11a: built.',
      '- [ ] 12a: built.',
      '',
      '## Revision 2026-10-31 (chef, split at readiness)',
      '',
      'This issue is now rows 11a and 19b. Row 12a moved to COR-1967.',
      '',
      '## Revision 2026-11-01',
      '',
      '- Dropped 19b: owner decision.',
    ].join('\n');
    const carriage = rowCarriage(body, ['11a', '12a', '19b']);
    expect([...carriage.criteria]).toEqual(['11a']);
    expect(carriage.deferred.size).toBe(0);
  });
});

describe('sectionOf and pathsIn', () => {
  test('takes a section with its nested headings, up to the next peer heading', () => {
    const section = sectionOf(description, /execution\s+brief/i) ?? '';
    expect(section).toContain('Add the thing');
    expect(section).toContain('Nested text');
    expect(section).not.toContain('It works');
    expect(sectionOf(description, /nonexistent/)).toBeUndefined();
  });

  test('finds path-like code spans only and drops line suffixes', () => {
    expect(pathsIn(description)).toEqual(['scripts/chef/thing.ts', 'scripts/chef/thing.test.ts']);
  });
});

describe('renderBrief', () => {
  const options = { paths: [], verify: [], model: 'Sonnet' };

  test('holds the sections, the files, the default verification and every charter rule', () => {
    const text = renderBrief(issue(description), options);
    expect(text).toContain('# COR-7: Add the thing');
    expect(text).toContain('## Execution brief\n\nAdd the thing');
    expect(text).toContain('## Acceptance criteria\n\n- It works.');
    expect(text).not.toContain('Ignore me');
    expect(text).toContain('- `scripts/chef/thing.ts`');
    expect(text).toContain('- `bun scripts/chef/focused-checks.ts`');
    expect(text).not.toContain('- `bun run lint:root`');
    expect(text).toContain('Model: Sonnet');
    for (const rule of charterRules) expect(text).toContain(rule);
  });

  test('explicit paths and verification commands replace the derived ones', () => {
    const text = renderBrief(issue(description), {
      ...options,
      paths: ['a/b.ts'],
      verify: ['bun test a'],
    });
    expect(text).toContain('- `a/b.ts`');
    expect(text).not.toContain('thing.test.ts');
    expect(text).toContain('- `bun test a`');
    expect(text).not.toContain('- `bun run typecheck:root`');
  });

  test('the default verification is the one focused-checks command', () => {
    expect(verificationCommands([])).toEqual(['bun scripts/chef/focused-checks.ts']);
    expect(verificationCommands(['bun scripts/chef/focused-checks.ts'])).toEqual([
      'bun scripts/chef/focused-checks.ts',
    ]);
  });

  test('explicit verification commands always keep the root lint, once', () => {
    expect(verificationCommands(['bun test a'])).toEqual(['bun test a', 'bun run lint:root']);
    expect(verificationCommands(['bun run lint:root', 'bun test a'])).toEqual([
      'bun run lint:root',
      'bun test a',
    ]);
    const text = renderBrief(issue(description), { ...options, verify: ['bun test a'] });
    expect(text).toContain('- `bun test a`\n- `bun run lint:root`');
  });

  test('a description with neither heading is included whole, and an empty one says so', () => {
    expect(renderBrief(issue('Just prose about `src/x/y.ts`.'), options)).toContain(
      'Just prose about',
    );
    expect(renderBrief(issue('Just prose about `src/x/y.ts`.'), options)).toContain('`src/x/y.ts`');
    expect(renderBrief(issue(null), options)).toContain('no description');
  });

  test('a description with criteria but no execution-brief heading is included whole', () => {
    const body =
      '## Scope\n\nRemove `a/b.ts`.\n\n## Acceptance criteria\n\n- It is gone.\n\n## Verification\n\n`bun test a`';
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Remove `a/b.ts`.');
    expect(text).toContain('- It is gone.');
    expect(text).toContain('`bun test a`');
    expect(text).not.toContain('no description');
  });

  test('carries the design rows even when an execution brief would hide them', () => {
    const body = [
      '## Execution brief',
      'Build the chat header.',
      '',
      '## Acceptance criteria',
      '- [ ] 11a: New chat is built around the composer (board NewChat).',
      '',
      '## Design source',
      '',
      'Prototypes: [canvas](https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw). Index rows:',
      '* **11a** (Chat): Rebuild New chat around the composer',
      '* **12a** (Chat): Composer bar shows model, effort and permission mode',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain('## Design');
    expect(text).toContain('**12a** (Chat): Composer bar');
    expect(text).toContain('https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw');
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
    expect(text).not.toContain('Rows not named in the acceptance criteria: 11a');
    expect(text).toContain('bun scripts/design-review-rows.ts');
    expect(text).toContain('`unverified` block the pull request');
    expect(text).toContain('tmp/chef/briefs/COR-7/boards/');
  });

  test('does not repeat the rows when the whole description is already the brief', () => {
    const body =
      '## Acceptance criteria\n\n- [ ] 11a: done\n\n## Design source\n\n* **11a** (Chat): one\n* **12a** (Chat): two';
    const text = renderBrief(issue(body), options);
    expect(text.split('**12a** (Chat): two')).toHaveLength(2);
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
  });

  test('carries a recorded deferral and does not ask the worker to build that row', () => {
    const body = [
      '## Execution brief',
      'Build the chat list.',
      '',
      '## Acceptance criteria',
      '- [ ] 11a: built.',
      '',
      '## Design source',
      '',
      '* **11a** (Chat): one',
      '* **19b** (Every list page): two',
      '',
      '## Scope notes',
      '',
      'Deferred: 19b, because the list pages are redone in COR-2001.',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Deferred on this issue, do not build: 19b (Deferred: 19b, because');
    expect(text).not.toContain('Rows not named in the acceptance criteria');
  });

  test('tells the worker that a rows-file board is the saved file stem', () => {
    const body = '## Design source\n\n* **11a** (Chat): one';
    expect(renderBrief(issue(body), options)).toContain('the file stem you saved under `boards/`');
  });

  test('a canvas link with no design section takes its rows from the whole description', () => {
    const body =
      'Build it per https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw.\n\n## Acceptance criteria\n\n- [ ] 11a: built.\n\n## Notes\n\n- 12a: also on the board.';
    const text = renderBrief(issue(body), options);
    expect(text).toContain('Rows not named in the acceptance criteria: 12a.');
  });

  test('a row a revision moved elsewhere is reported as moved, not as a missing criterion', () => {
    const body = [
      '## Execution brief',
      'Build the chat list.',
      '',
      '## Acceptance criteria',
      '- [ ] 11b: built.',
      '',
      '## Design source',
      '',
      '* **11a** (Chat): one',
      '* **11b** (Chat): two',
      '',
      '## Revision 2026-11-01',
      '',
      'Row 11a moved to COR-8.',
    ].join('\n');
    const text = renderBrief(issue(body), options);
    expect(text).toContain(
      'Moved off this issue by a revision, do not build: 11a (Row 11a moved to COR-8.)',
    );
    expect(text).not.toContain('Rows not named in the acceptance criteria');
  });

  test('an issue with no design gets no design section', () => {
    expect(renderBrief(issue(description), options)).not.toContain('## Design');
  });

  test('cuts a very long description and says so', () => {
    const text = renderBrief(issue('x'.repeat(40_000)), options);
    expect(text).toContain('description cut at 16000');
    expect(text.length).toBeLessThan(21_000);
  });
});

describe('charter rules', () => {
  test('leave merging to the coordinator', () => {
    const rules = charterRules.join('\n');
    expect(rules).not.toContain('merge-gate.ts --pr');
    expect(rules).toContain('you do not merge');
  });

  // The charter rules are the one source of the worker-facing rules. Each pair names a phrase of a
  // charter rule and the phrase of the governing rule it restates, in AGENTS.md or in the execution
  // record's remaining coordinator text, so a change to either side that drops the rule fails here.
  const normalize = (text: string) => text.replace(/\s+/g, ' ').toLowerCase();
  const read = (path: string) =>
    normalize(readFileSync(join(import.meta.dir, '../..', path), 'utf8'));
  const agents = 'AGENTS.md';
  const record = '.agents/skills/chef/references/execution-record.md';
  const governing: [charter: string, document: string, rule: string][] = [
    ['focused checks on what you changed', agents, 'focused checks on what it changed'],
    ['`bun scripts/chef/focused-checks.ts`', agents, '`bun scripts/chef/focused-checks.ts`'],
    ['is named `*.integration.test.ts`', agents, 'is named `*.integration.test.ts`'],
    [
      'bun scripts/affected-tests.ts run --isolated',
      agents,
      'bun scripts/affected-tests.ts run --isolated',
    ],
    ['the full suite only for a one-way door', agents, 'to a one-way door'],
    ['delivery runs no gate', agents, 'delivery runs no gate'],
    [
      'a red `main` is a warning',
      '.agents/skills/chef/references/program-runs.md',
      '`merge-gate.ts` warns, and never refuses',
    ],
    ['you do not merge', record, 'the worker does not merge'],
    ['open no pull request unless the dispatch asks', agents, 'the worker pushes its branch'],
    [
      'git fetch origin main && git merge fetch_head',
      agents,
      'git fetch origin main && git merge fetch_head',
    ],
    [
      'never `git reset --soft` onto a newer `main`',
      agents,
      'never `git reset --soft` onto a newer `main`',
    ],
    ['`bun scripts/chef/revert-check.ts`', agents, '`bun scripts/chef/revert-check.ts`'],
    [
      '`git diff --name-only origin/main...head`',
      agents,
      '`git diff --name-only origin/main...head`',
    ],
    ['there is no context ceiling', agents, 'a worker has no context ceiling'],
    ['never poll', agents, 'never poll'],
    ['answer every thread before merge', agents, 'answer every thread before merge'],
    ['at most three rounds', agents, 'cap review at three rounds'],
    ['round one fixes every real finding', agents, 'fix every real finding in round one'],
    ['push once per round', agents, 'push once per round'],
    ['codex reviews every push automatically', agents, 'codex reviews every push'],
    ['end a turn only on a state change', agents, 'end a turn only on a state change'],
    ['review-threads.ts classes --pr <n>', record, 'review-threads.ts classes --pr <n>` exits 1'],
    [
      'two unsuccessful attempts at the same defect or acceptance criterion',
      record,
      'attempts per defect/acceptance criterion',
    ],
    [
      'return evidence for causal reassessment',
      record,
      'causal reassessment after two unsuccessful attempts',
    ],
    [
      'verified: a named command passed or a manual check was done',
      record,
      'name the command or manual check behind each verified criterion',
    ],
  ];

  test('each restate a rule that AGENTS.md or the execution record still carries', () => {
    const rules = normalize(charterRules.join('\n'));
    for (const [charter, document, rule] of governing) {
      expect(rules, charter).toContain(normalize(charter));
      expect(read(document), `${document}: ${rule}`).toContain(normalize(rule));
    }
  });

  test('are not restated by references/execution-record.md, which points at brief.ts', () => {
    const text = read(record);
    expect(text).toContain(normalize('`charterRules` in `scripts/chef/brief.ts`'));
    for (const phrase of [
      'final message is the report',
      'answer every thread before merge',
      'at most three rounds',
      'end a turn only on a state change',
      'check the diff against every class',
      'give every criterion exactly one status',
      'not verified: not checked',
      'return evidence for causal reassessment',
    ]) {
      expect(rules(phrase), phrase).toBe(true);
      expect(text, phrase).not.toContain(phrase);
    }
  });

  function rules(phrase: string): boolean {
    return normalize(charterRules.join('\n')).includes(phrase);
  }
});

describe('report rule', () => {
  const rule = charterRules.find((candidate) => candidate.startsWith('**Report:**'));

  test('makes the final message the report and keeps files out of it', () => {
    expect(rule).toBeDefined();
    expect(rule).toContain('final message is the report');
    expect(rule).toContain('at most 15 lines');
    expect(rule).toContain('do not create a `report.md`');
    expect(rule).toContain('tmp/chef/<package>/round-<n>/');
  });

  test('no charter rule requires writing a report file', () => {
    expect(charterRules.join('\n')).not.toMatch(/write (?:the )?(?:full )?report/i);
  });

  test('the brief a worker receives carries the report rule', () => {
    const text = renderBrief(issue(description), { paths: [], verify: [], model: 'Sonnet' });
    expect(text).toContain(rule!);
  });
});

describe('the create-task ticket template', () => {
  const template = readFileSync(
    join(import.meta.dir, '../../.agents/skills/create-task/ticket-template.md'),
    'utf8',
  );

  test('has exactly the agreed headings, in order, and no open-questions section', () => {
    expect([...template.matchAll(/^(#{2,3}) (.+)$/gm)].map((match) => match[0])).toEqual([
      '## Brief',
      '## Current behavior',
      '## Acceptance criteria',
      '## Decisions',
      '## Out of scope',
      '## Constraints',
      '## Files',
      '## Verification',
      '## Delivery boundary',
    ]);
  });

  test('every section of a filled template reaches the worker', () => {
    const filled = template.replace(
      /^(## (.+))\n\n<!--[^]*?-->/gm,
      (_match, heading: string, title: string) =>
        title === 'Files'
          ? `${heading}\n\n- \`scripts/chef/thing.ts\``
          : title === 'Verification'
            ? `${heading}\n\n- \`bun test scripts/chef/thing.test.ts\``
            : `${heading}\n\nFilled ${title.toLowerCase()}.`,
    );
    const text = renderBrief(issue(filled), { paths: [], verify: [], model: 'Sonnet' });
    for (const [title, body] of [
      ['Execution brief', 'Filled brief.'],
      ['Current behavior', 'Filled current behavior.'],
      ['Acceptance criteria', 'Filled acceptance criteria.'],
      ['Decisions', 'Filled decisions.'],
      ['Out of scope', 'Filled out of scope.'],
      ['Constraints', 'Filled constraints.'],
      ['Files', '- `scripts/chef/thing.ts`'],
      ['Verification', '- `bun test scripts/chef/thing.test.ts`\n- `bun run lint:root`'],
      ['Delivery boundary', 'Filled delivery boundary.'],
    ])
      expect(text).toContain(`## ${title}\n\n${body}`);
  });
});

describe('an issue written with a Brief heading and a dated revision', () => {
  const written = [
    '## Brief',
    '',
    'Refuse the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The thing is refused (test).',
    '',
    '## Notes',
    '',
    'Not carried.',
    '',
    '## Revision 2026-11-09 (decision)',
    '',
    'Standalone callers keep the old behavior; add a test.',
  ].join('\n');

  test('carries the brief, the criteria and the revision, and leaves other sections out', () => {
    const text = renderBrief(issue(written), { paths: [], verify: [], model: 'Sonnet' });
    expect(text).toContain('## Execution brief\n\nRefuse the thing.');
    expect(text).toContain('## Acceptance criteria\n\n- [ ] The thing is refused (test).');
    expect(text).toContain(
      '## Revision 2026-11-09 (decision)\n\nStandalone callers keep the old behavior; add a test.',
    );
    expect(text).not.toContain('Not carried.');
  });
});

describe('open blockers', () => {
  const blocker = (identifier: string, state: string, stateType: string) => ({
    identifier,
    title: `Title of ${identifier}`,
    state,
    stateType,
  });

  test('lists each open blocker and tells the worker not to start', () => {
    const text = blockerLines({ open: [blocker('COR-3', 'In Progress', 'started')] }).join('\n');
    expect(text).toContain('## Open blockers\n\n- COR-3 [In Progress] Title of COR-3');
    expect(text).toContain('return blocked');
  });

  test('says None only when the relations were read and none is open', () => {
    expect(blockerLines({ open: [] })).toEqual(['## Open blockers', '', 'None', '']);
    expect(blockerLines(undefined).join('\n')).toContain('not read');
    expect(blockerLines({ unreadable: 'more than 100 relations' }).join('\n')).toContain(
      'could not be read: more than 100 relations',
    );
    expect(blockerLines(undefined).join('\n')).not.toContain('None');
  });

  test('a rendered brief carries the section', () => {
    const text = renderBrief(issue(description), {
      paths: [],
      verify: [],
      model: 'Sonnet',
      blockers: { open: [] },
    });
    expect(text).toContain('## Open blockers\n\nNone');
  });
});

describe('run', () => {
  const relations = (open: boolean) => ({
    issue: {
      id: 'uuid-7',
      identifier: 'COR-7',
      relations: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: {
        nodes: open
          ? [
              {
                type: 'blocks',
                issue: {
                  identifier: 'COR-5',
                  title: 'Earlier',
                  state: { name: 'Ready', type: 'unstarted' },
                },
              },
            ]
          : [],
        pageInfo: { hasNextPage: false },
      },
    },
  });
  const answer =
    (open: boolean, comments: { id: string; body: string; createdAt: string }[] = []): FetchLike =>
    async (_url, init) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      const data = query.includes('IssueRelations')
        ? relations(open)
        : query.includes('IssueComments')
          ? {
              issue: {
                comments: { nodes: comments, pageInfo: { hasNextPage: false, endCursor: null } },
              },
            }
          : { issue: issue(description) };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };
  const claimComment = (run: string, checkpoint: string, status = 'held') => [
    {
      id: 'c-1',
      createdAt: checkpoint,
      body: `Claim: run ${run}, branch cor-7-x, since 2026-11-10T09:00:00Z, checkpoint ${checkpoint}, head abc1234, status ${status}\n\nWritten by scripts/chef/linear.ts claim.`,
    },
  ];
  const justNow = () => new Date('2026-11-10T12:00:00Z');
  const fetchIssue = answer(false);
  const dependencies = { fetch: fetchIssue, environment: { LINEAR_API_KEY: 'lin_api_test_value' } };

  test('writes <ID>.md in the output directory and reports it', async () => {
    const result = await run(['COR-7', '--out-dir', sandbox, '--json'], dependencies);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output) as { path: string };
    expect(parsed.path).toBe(join(sandbox, 'COR-7.md'));
    expect(readFileSync(parsed.path, 'utf8')).toContain('## Charter rules');
    expect(readFileSync(parsed.path, 'utf8')).toContain('## Open blockers\n\nNone');
  });

  test('writes the open blockers it reads from Linear', async () => {
    const result = await run(['COR-7', '--out-dir', sandbox, '--json'], {
      ...dependencies,
      fetch: answer(true),
    });
    const parsed = JSON.parse(result.output) as { path: string };
    expect(readFileSync(parsed.path, 'utf8')).toContain('- COR-5 [Ready] Earlier');
  });

  test('reports a missing issue as exit 1 and bad usage as a UsageError', async () => {
    const missing: FetchLike = async () =>
      new Response(JSON.stringify({ data: { issue: null } }), { status: 200 });
    const result = await run(['COR-9', '--out-dir', sandbox], { ...dependencies, fetch: missing });
    expect(result.code).toBe(1);
    expect(result.output).toContain('No issue COR-9');
    expect(await rejectionOf(run([], dependencies))).toBeInstanceOf(UsageError);
    expect(await rejectionOf(run(['not an id'], dependencies))).toBeInstanceOf(UsageError);
  });

  test('prints the live claim in the brief when it is this run\'s, and "None" without one', async () => {
    const none = await run(['COR-7', '--stdout'], dependencies);
    expect(none.output).toContain('## Claim\n\nnone');
    const mine = await run(['COR-7', '--out-dir', sandbox, '--run', 'run-a', '--json'], {
      ...dependencies,
      fetch: answer(false, claimComment('run-a', '2026-11-10T11:00:00Z')),
      now: justNow,
    });
    expect(mine.code).toBe(0);
    const text = readFileSync(join(sandbox, 'COR-7.md'), 'utf8');
    expect(text).toContain(
      '## Claim\n\nheld by run run-a on branch cor-7-x since 2026-11-10T09:00:00Z, last checkpoint 2026-11-10T11:00:00Z, head abc1234',
    );
    expect(text).toContain(
      'Checkpoint after every push, with the pushed head: `bun scripts/chef/linear.ts claim COR-7 --run run-a --branch cor-7-x --head <sha>`.',
    );
  });

  test("another run's live claim is exit 1 and no brief is written, with or without --run", async () => {
    const held = {
      ...dependencies,
      fetch: answer(false, claimComment('run-a', '2026-11-10T11:00:00Z')),
      now: justNow,
    };
    for (const extra of [['--run', 'run-b'], []]) {
      const result = await run(['COR-7', '--out-dir', sandbox, ...extra], held);
      expect(result.code).toBe(1);
      expect(result.output).toContain('held by run run-a on branch cor-7-x');
      expect(result.output).toContain('no brief was written');
    }
    expect(readdirSync(sandbox)).toEqual([]);
  });

  test('a released or expired claim does not refuse the brief; --stdout prints a foreign one', async () => {
    for (const comments of [
      claimComment('run-a', '2026-11-10T11:00:00Z', 'released'),
      claimComment('run-a', '2026-11-09T11:59:00Z'),
    ]) {
      const result = await run(['COR-7', '--out-dir', sandbox, '--run', 'run-b'], {
        ...dependencies,
        fetch: answer(false, comments),
        now: justNow,
      });
      expect(result.code).toBe(0);
    }
    const scout = await run(['COR-7', '--stdout', '--run', 'run-b'], {
      ...dependencies,
      fetch: answer(false, claimComment('run-a', '2026-11-10T11:00:00Z')),
      now: justNow,
    });
    expect(scout.code).toBe(0);
    expect(scout.output).toContain('held by run run-a');
  });

  const explode = () => {
    throw new Error('the read-only mode must not run git or touch a checkout');
  };

  test('--stdout prints the brief and writes nothing, with no checkout lookup', async () => {
    const before = readdirSync(sandbox);
    const result = await run(['COR-7', '--stdout'], dependencies, explode);
    expect(result.code).toBe(0);
    expect(result.output).toStartWith('# COR-7: Add the thing');
    expect(result.output).toContain('## Charter rules');
    expect(readdirSync(sandbox)).toEqual(before);
  });

  test('--stdout --json carries the text and its size; --out-dir is refused with it', async () => {
    const result = await run(['COR-7', '--stdout', '--json'], dependencies, explode);
    const parsed = JSON.parse(result.output) as { text: string; bytes: number };
    expect(parsed.bytes).toBe(Buffer.byteLength(parsed.text));
    expect(
      await rejectionOf(run(['COR-7', '--stdout', '--out-dir', sandbox], dependencies)),
    ).toBeInstanceOf(UsageError);
  });
});

describe('shared programme text', () => {
  const preamble = 'The programme preamble line.\n'.repeat(400);
  const sharedBody = `Source of truth: https://linear.app/team/document/chat-board-programme-abc123\n\n${preamble}`;
  const text = [
    '## Execution brief',
    'Do the part.',
    '',
    '## Shared programme text',
    '',
    sharedBody,
    '## Acceptance criteria',
    '- Done.',
  ].join('\n');

  test('a section that says it is shared and links its document is replaced by the link', () => {
    const stripped = stripShared(text);
    expect(stripped.omitted).toEqual([
      {
        heading: 'Shared programme text',
        link: 'https://linear.app/team/document/chat-board-programme-abc123',
        bytes: Buffer.byteLength(sharedBody.trim()),
      },
    ]);
    expect(stripped.text).not.toContain('The programme preamble line.');
    expect(stripped.text).toContain('Shared programme text, not repeated here: https://linear.app');
    expect(stripped.text).toContain('## Acceptance criteria');
  });

  test('a repository Markdown path counts as the link; a shared section with no link stays', () => {
    const byPath = stripShared(
      '## Programme preamble\n\nSee `documentation/repository/chat.md`.\nBody.\n',
    );
    expect(byPath.omitted[0]?.link).toBe('documentation/repository/chat.md');
    const unlinked = stripShared('## Shared context\n\nNo link here.\nBody.\n');
    expect(unlinked.omitted).toEqual([]);
    expect(unlinked.text).toContain('Body.');
  });

  test('an ordinary section is never stripped', () => {
    const plain = '## Notes\n\nhttps://example.com/x\nstays\n';
    expect(stripShared(plain)).toEqual({ text: plain, omitted: [] });
  });

  test('a brief carries the link, not the preamble, and ends with its exact size', () => {
    const brief = renderBrief(issue(text), { paths: [], verify: [], model: 'Sonnet' });
    expect(brief).not.toContain('The programme preamble line.');
    expect(brief).toContain('chat-board-programme-abc123');
    const match = /\nSize: (\d+) bytes\.\n$/.exec(brief);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(Buffer.byteLength(brief));
  });
});

describe('the delivery rule', () => {
  const root = join(import.meta.dir, '../..');

  test('every brief carries it once, as the one Delivery rule', () => {
    const brief = renderBrief(issue(description), { paths: [], verify: [], model: 'Sonnet' });
    expect(brief.split(deliveryRule).length - 1).toBe(1);
    expect(charterRules.filter((rule) => rule.startsWith('**Delivery:**'))).toHaveLength(1);
    expect(deliveryRule.split('. ')).toHaveLength(1);
  });

  test('the agent definition and the Codex protocol point at it instead of restating it', () => {
    for (const path of [
      '.claude/agents/chef-worker.md',
      '.agents/skills/chef/references/codex-protocol.md',
    ]) {
      const text = readFileSync(join(root, path), 'utf8');
      expect(text, path).toContain("brief's Delivery rule");
      expect(text, path).not.toMatch(/open no pull request unless/i);
    }
  });
});
