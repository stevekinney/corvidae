import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { FetchLike } from './linear.ts';
import { UsageError, type Runner } from './process-runner.ts';
import {
  doneFindings,
  draftComment,
  GitError,
  isBlocking,
  isExecutionReport,
  parseSections,
  pathOf,
  proposeAction,
  readyFindings,
  run,
  staleFindings,
  symbolsOf,
  type TriageDependencies,
  type TriageIssue,
} from './triage.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

const goodBody = `## Brief

Do the thing.

## Current behavior

It does not (verified, \`scripts/chef/a.ts:10\`; \`parseThing\` exists).

## Acceptance criteria

- AC1. \`bun test scripts/chef/a.test.ts\` passes.
- AC2. \`bun run lint:root\` passes.

## Decisions

- Use the helper \`parseThing\` (COR-5 decision).

## Out of scope

Nothing.

## Constraints

None.

## Files

- \`scripts/chef/a.ts\`
- \`scripts/chef/a.test.ts\`

## Verification

- \`bun test scripts/chef/a.test.ts\`
- \`bun run lint:root\`

## Delivery boundary

A merged pull request.
`;

function issue(identifier: string, description: string | null, state = 'Backlog'): TriageIssue {
  return {
    identifier,
    title: `Title ${identifier}`,
    description,
    updatedAt: '2026-10-01T00:00:00.000Z',
    state: { name: state, type: state === 'Done' ? 'completed' : 'unstarted' },
  };
}

const codes = (findings: { code: string }[]) => findings.map((finding) => finding.code);

describe('readyFindings', () => {
  test('a complete ticket has no findings', () => {
    expect(readyFindings(goodBody)).toEqual([]);
  });

  test('a missing description is one finding', () => {
    expect(codes(readyFindings(null))).toEqual(['no-description']);
    expect(codes(readyFindings('  '))).toEqual(['no-description']);
  });

  test('missing and empty sections are named; template comments do not count as content', () => {
    const body = goodBody
      .replace('## Constraints\n\nNone.\n\n', '')
      .replace('Nothing.', '<!-- fill me in -->');
    const findings = readyFindings(body);
    expect(findings.map((finding) => finding.message)).toEqual([
      'The template\'s "out of scope" section is empty.',
      'The template\'s "constraints" section is missing.',
    ]);
    expect(findings.every((finding) => !isBlocking(finding))).toBe(true);
  });

  test('only the Definition of Ready blocks: a section it requires is a blocking finding', () => {
    const body = goodBody.replace(/## Delivery boundary\n[\s\S]*$/, '');
    const blocking = readyFindings(body).filter(isBlocking);
    expect(blocking.map((finding) => finding.message)).toEqual([
      'The "delivery boundary" section is missing.',
    ]);
  });

  test('an issue written before the template, meeting the Definition of Ready, is kept', () => {
    // The shape of COR-2102 on 2026-11-09: Brief, Files, unnumbered binary criteria, Verification
    // and a Delivery boundary, with no Current behavior, Decisions, Out of scope or Constraints.
    const body = [
      '## Brief',
      '',
      'One taint threshold for every scan path.',
      '',
      '## Files',
      '',
      '- `scripts/chef/a.ts`',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Every scan path reads the one threshold.',
      '',
      '## Verification',
      '',
      '- `bun test scripts/chef/a.test.ts`',
      '',
      '## Delivery boundary',
      '',
      'A merged pull request.',
    ].join('\n');
    const findings = readyFindings(body);
    expect(findings.filter(isBlocking)).toEqual([]);
    expect(codes(findings)).toContain('criteria-unnumbered');
    expect(proposeAction('ready', 'Backlog', findings)).toBe('keep');
  });

  test('criteria must be numbered from AC1 in order', () => {
    const unnumbered = goodBody.replace(/AC\d\./g, '-');
    expect(codes(readyFindings(unnumbered))).toEqual(['criteria-unnumbered']);
    const skipped = goodBody.replace('AC2.', 'AC3.');
    expect(codes(readyFindings(skipped))).toEqual(['criteria-sequence']);
  });

  test('Files needs code spans and Verification needs commands', () => {
    const body = goodBody
      .replace(/- `scripts\/chef\/a\.ts`\n- `scripts\/chef\/a\.test\.ts`/, '- the chef scripts')
      .replace(/- `bun test scripts\/chef\/a\.test\.ts`\n- `bun run lint:root`/, '- run the tests');
    expect(codes(readyFindings(body))).toEqual(['files-no-code-spans', 'verification-no-commands']);
  });

  test('fenced verification commands count', () => {
    const body = goodBody.replace(
      /- `bun test scripts\/chef\/a\.test\.ts`\n- `bun run lint:root`/,
      '```sh\nbun test x\n```',
    );
    expect(readyFindings(body)).toEqual([]);
  });

  test('unanswered markers, Decisions questions and open questions are findings', () => {
    const body = `${goodBody.replace('(COR-5 decision).', 'TBD.\n- Should it retry?')}\n## Open questions\n\n- Which host?\n`;
    expect(codes(readyFindings(body))).toEqual([
      'unanswered-marker',
      'unanswered-question',
      'open-questions',
    ]);
  });

  test('TODO inside a code span is not a marker and "None" open questions are fine', () => {
    const body = `${goodBody.replace('Do the thing.', 'Remove the `TODO` lint.')}\n## Open questions\n\nNone.\n`;
    expect(readyFindings(body)).toEqual([]);
  });

  test('headings inside a fenced block are not sections', () => {
    const sections = parseSections('## Brief\n\n```\n## Not a heading\n```\n');
    expect([...sections.keys()]).toEqual(['brief']);
  });
});

function fakeRunner(options: { symbols?: string[]; commits?: string; grepCode?: number } = {}): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    if (command[1] === 'grep') {
      if (options.grepCode !== undefined)
        return { code: options.grepCode, stdout: '', stderr: 'boom' };
      const symbol = command.at(-1) ?? '';
      return { code: (options.symbols ?? []).includes(symbol) ? 0 : 1, stdout: '', stderr: '' };
    }
    if (command[1] === 'log') return { code: 0, stdout: options.commits ?? '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, calls };
}

const staleBody = goodBody.replace('(COR-5 decision)', '(COR-5 decision, see COR-7)');

describe('pathOf and symbolsOf', () => {
  test('pathOf strips line suffixes and rejects non-paths', () => {
    expect(pathOf('scripts/chef/a.ts:10-20')).toBe('scripts/chef/a.ts');
    expect(pathOf('./package.json')).toBe('package.json');
    expect(pathOf('bun test x')).toBeUndefined();
    expect(pathOf('src/**/*.ts')).toBeUndefined();
    expect(pathOf('parseThing')).toBeUndefined();
  });

  test('symbolsOf keeps distinctive identifiers outside Files, by last segment', () => {
    const symbols = symbolsOf(
      goodBody
        .replace('Do the thing.', 'Use `linear.fetchIssue`, `Runner`, `bun`, `a_b_c()`, `a.ts`.')
        .replace('It does not', 'It uses `linear.fetchIssue` and `a_b_c()` and does not'),
    );
    expect(symbols).toEqual(['fetchIssue', 'a_b_c', 'parseThing']);
  });

  test('symbolsOf ignores symbols a criterion or decision proposes to add', () => {
    const symbols = symbolsOf(
      goodBody.replace(
        '- AC1.',
        '- AC1: `staleProposalFor()` returns propose-close. `newThing.run`',
      ),
    );
    expect(symbols).toEqual(['parseThing']);
  });
});

describe('staleFindings', () => {
  const baseContext = (overrides: Partial<Parameters<typeof staleFindings>[1]> = {}) => ({
    runner: fakeRunner({ symbols: ['parseThing'] }).runner,
    pathExists: (path: string) => path === 'scripts/chef/a.ts',
    pullRequests: [],
    issueState: async (identifier: string) =>
      identifier === 'COR-7' ? { name: 'Done', type: 'completed' } : undefined,
    ...overrides,
  });

  test('reports a missing file, a closed reference and nothing else for a sound premise', async () => {
    const findings = await staleFindings(issue('COR-1', staleBody), baseContext());
    expect(findings.map((finding) => finding.code)).toEqual(['missing-file', 'referenced-closed']);
    expect(findings[0]?.message).toContain('scripts/chef/a.test.ts');
    expect(findings[1]?.message).toBe('COR-7 is referenced but is already Done.');
  });

  test('does not report a new symbol a criterion proposes to add', async () => {
    const findings = await staleFindings(
      issue(
        'COR-1',
        goodBody.replace('- AC1.', '- AC1: `staleProposalFor()` returns propose-close.'),
      ),
      baseContext({ pathExists: () => true }),
    );
    expect(codes(findings)).not.toContain('missing-symbol');
  });

  test('reports a missing symbol', async () => {
    const findings = await staleFindings(
      issue('COR-1', goodBody),
      baseContext({ runner: fakeRunner({ symbols: [] }).runner, pathExists: () => true }),
    );
    expect(codes(findings)).toEqual(['missing-symbol']);
  });

  test('reports commits since updatedAt on existing files only', async () => {
    const { runner, calls } = fakeRunner({
      symbols: ['parseThing'],
      commits: 'abc123 Change a\ndef456 Change b\n',
    });
    const findings = await staleFindings(
      issue('COR-1', goodBody),
      baseContext({ runner, pathExists: () => true }),
    );
    expect(findings).toEqual([
      {
        code: 'files-changed',
        message:
          '2 commits touched the listed files since 2026-10-01T00:00:00.000Z: abc123 Change a; def456 Change b.',
      },
    ]);
    const log = calls.find((call) => call[1] === 'log');
    expect(log).toContain('--since=2026-10-01T00:00:00.000Z');
    expect(log?.slice(-2)).toEqual(['scripts/chef/a.ts', 'scripts/chef/a.test.ts']);
  });

  test('reports a merged pull request that names the issue', async () => {
    const findings = await staleFindings(
      issue('COR-1', goodBody),
      baseContext({
        pathExists: () => true,
        pullRequests: [
          {
            number: 42,
            title: 'COR-1: do it',
            headRefName: 'b',
            body: '',
            state: 'MERGED',
            mergedAt: '2026-10-05T00:00:00Z',
          },
          {
            number: 43,
            title: 'COR-1 draft',
            headRefName: 'c',
            body: '',
            state: 'OPEN',
            mergedAt: null,
          },
        ],
      }),
    );
    expect(findings).toEqual([
      { code: 'merged-pr', message: 'Pull request #42 references it and has merged.' },
    ]);
  });

  test('a git failure is thrown, never read as absence', async () => {
    const context = baseContext({ runner: fakeRunner({ grepCode: 128 }).runner });
    const failure = await rejectionOf(staleFindings(issue('COR-1', goodBody), context));
    expect(failure).toBeInstanceOf(GitError);
  });
});

describe('doneFindings', () => {
  const merged = (body: string) => ({
    number: 9,
    title: 'x',
    headRefName: 'y',
    body,
    state: 'MERGED',
    mergedAt: '2026-10-05T00:00:00Z',
  });

  test('a linked merged pull request or an execution report is evidence', () => {
    const done = issue('COR-1', goodBody, 'Done');
    expect(doneFindings(done, [merged('Refs COR-1')], [])).toEqual([]);
    expect(
      doneFindings(done, [], ['Execution report: worktree-x attempt 2\n\n## Execution status']),
    ).toEqual([]);
  });

  test('a passing mention, an open pull request, or no comment is not', () => {
    const done = issue('COR-1', goodBody, 'Done');
    const open = { ...merged('Refs COR-1'), state: 'OPEN', mergedAt: null };
    for (const pullRequests of [[merged('moved to COR-1')], [open]])
      expect(codes(doneFindings(done, pullRequests, ['Looks good']))).toEqual(['no-evidence']);
  });

  test('the report marker is the first non-empty line', () => {
    expect(isExecutionReport('\nExecution report: b attempt 1\nrest')).toBe(true);
    expect(isExecutionReport('Execution report: b attempt 0')).toBe(false);
    expect(isExecutionReport('See Execution report: b attempt 1')).toBe(false);
  });
});

describe('actions and drafts', () => {
  const finding = [{ code: 'missing-file', message: 'gone' }];

  test('ready: Backlog refines, Ready demotes, clean keeps', () => {
    expect(proposeAction('ready', 'Backlog', finding)).toBe('needs-refinement');
    expect(proposeAction('ready', 'Ready', finding)).toBe('propose-backlog');
    expect(proposeAction('ready', 'Backlog', [])).toBe('keep');
  });

  test('stale: a merged pull request closes, a stale premise on Ready demotes', () => {
    const merged = [{ code: 'merged-pr', message: 'm' }, ...finding];
    expect(proposeAction('stale', 'In Progress', merged)).toBe('propose-close');
    expect(proposeAction('stale', 'Ready', finding)).toBe('propose-backlog');
    expect(proposeAction('stale', 'Backlog', finding)).toBe('needs-refinement');
    expect(proposeAction('stale', 'Backlog', [{ code: 'files-changed', message: 'c' }])).toBe(
      'needs-refinement',
    );
  });

  test('only needs-refinement and propose-backlog carry a comment draft', () => {
    expect(draftComment('ready', 'needs-refinement', finding)).toContain('- gone');
    expect(draftComment('ready', 'propose-backlog', finding)).toContain('move back to Backlog');
    expect(draftComment('stale', 'propose-close', finding)).toBeUndefined();
    expect(draftComment('stale', 'keep', [])).toBeUndefined();
    expect(draftComment('done', 'needs-refinement', finding)).toContain('execution report');
  });
});

// Command line ------------------------------------------------------------------------------

interface Served {
  issues?: TriageIssue[];
  byId?: Record<string, TriageIssue>;
  comments?: Record<string, string[]>;
  fail?: boolean;
}

function fakeLinear(served: Served) {
  const log: { operation: string; variables: Record<string, any> }[] = [];
  const fetchLike: FetchLike = async (_url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
      query: string;
      variables: Record<string, any>;
    };
    const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? '';
    log.push({ operation, variables: body.variables });
    if (served.fail) return new Response('nope', { status: 502 });
    switch (operation) {
      case 'TriageIssues':
        return Response.json({
          data: {
            issues: {
              nodes: served.issues ?? [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case 'TriageIssue':
        return Response.json({ data: { issue: served.byId?.[body.variables['id']] ?? null } });
      case 'TriageComments':
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: (served.comments?.[body.variables['id']] ?? []).map((text) => ({
                  body: text,
                })),
              },
            },
          },
        });
      case 'TriageReferenced':
        return Response.json({ data: { issue: { state: { name: 'Done', type: 'completed' } } } });
      default:
        throw new Error(`Unexpected operation ${operation}`);
    }
  };
  return { fetchLike, log };
}

function dependencies(
  served: Served,
  extra: Partial<TriageDependencies> = {},
): { dependencies: TriageDependencies; log: ReturnType<typeof fakeLinear>['log'] } {
  const { fetchLike, log } = fakeLinear(served);
  const { runner } = fakeRunner({ symbols: ['parseThing'] });
  const prRunner: Runner = (command) =>
    command[0] === 'gh' ? { code: 0, stdout: '[]', stderr: '' } : runner(command);
  return {
    log,
    dependencies: {
      fetch: fetchLike,
      environment: { LINEAR_API_KEY: 'lin_test' },
      runner: prRunner,
      now: () => NOW,
      pathExists: () => true,
      ...extra,
    },
  };
}

describe('run', () => {
  test('ready lists Backlog by default and exits 0 when every issue is ready', async () => {
    const { dependencies: deps, log } = dependencies({ issues: [issue('COR-1', goodBody)] });
    const result = await run(['ready'], deps);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      'ready: 1 issue, 0 with findings.\nCOR-1 [Backlog] keep (0 findings) Title COR-1',
    );
    expect(log[0]?.variables['filter'].state).toEqual({ name: { eq: 'Backlog' } });
    expect(log[0]?.variables['filter'].team).toEqual({ key: { eq: 'COR' } });
  });

  test('ready --json reports findings, the action and the comment draft with exit 1', async () => {
    const { dependencies: deps } = dependencies({ issues: [issue('COR-2', '## Brief\n\nx')] });
    const result = await run(['ready', '--json'], deps);
    const parsed = JSON.parse(result.output);
    expect(result.code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].action).toBe('needs-refinement');
    expect(parsed.issues[0].findings.length).toBe(8);
    expect(parsed.issues[0].comment).toContain('Definition of Ready');
  });

  test('--issue reads each issue; an unknown one is a usage error', async () => {
    const { dependencies: deps } = dependencies({ byId: { 'COR-1': issue('COR-1', goodBody) } });
    const single = await run(['ready', '--issue', 'cor-1'], deps);
    expect(single.code).toBe(0);
    expect(await rejectionOf(run(['ready', '--issue', 'COR-99'], deps))).toBeInstanceOf(UsageError);
  });

  test('jev shadow is advisory and never changes the verdict', async () => {
    const asked: string[] = [];
    const { dependencies: deps } = dependencies(
      { issues: [issue('COR-1', goodBody)] },
      {
        shadow: async (predicate) => {
          asked.push(predicate);
          return { decision: 'no', confidence: 0.9, outcome: 'decided' };
        },
      },
    );
    const result = await run(['ready', '--jev', 'shadow'], deps);
    expect(result.code).toBe(0);
    expect(asked).toEqual(['criteria-binary', 'verification-exact', 'unanswered-question']);
    expect(result.output).toContain('~ criteria-binary: no (0.90) [advisory, decided]');
  });

  test('a throwing shadow is recorded as an error advisory', async () => {
    const { dependencies: deps } = dependencies(
      { issues: [issue('COR-1', goodBody)] },
      {
        shadow: async () => {
          throw new Error('secret');
        },
      },
    );
    const result = await run(['ready', '--jev', 'shadow', '--json'], deps);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).issues[0].advisory[0]).toEqual({
      predicate: 'criteria-binary',
      decision: null,
      confidence: null,
      outcome: 'error Error',
    });
  });

  test('done flags issues without evidence', async () => {
    const done = [issue('COR-1', goodBody, 'Done'), issue('COR-2', goodBody, 'Done')];
    const { dependencies: deps, log } = dependencies({
      issues: done,
      comments: { 'COR-2': ['Execution report: b attempt 1\n\nok'] },
    });
    const result = await run(['done', '--since', '2026-10-15'], deps);
    expect(result.code).toBe(1);
    expect(result.output).toContain('COR-1 [Done] needs-refinement (1 finding)');
    expect(result.output).toContain('COR-2 [Done] keep (0 findings)');
    const filter = log[0]?.variables['filter'];
    expect(filter.completedAt).toEqual({ gte: '2026-10-15T00:00:00.000Z' });
    expect(filter.state).toEqual({ type: { eq: 'completed' } });
  });

  test('done defaults the window to 30 days', async () => {
    const { dependencies: deps, log } = dependencies({ issues: [] });
    const result = await run(['done'], deps);
    expect(result.code).toBe(0);
    expect(log[0]?.variables['filter'].completedAt).toEqual({ gte: '2026-10-10T12:00:00.000Z' });
  });

  test('stale proposes closing an issue a merged pull request references', async () => {
    const prs = JSON.stringify([
      {
        number: 7,
        title: 'x',
        headRefName: 'b',
        body: 'Refs COR-1',
        state: 'MERGED',
        mergedAt: '2026-10-05T00:00:00Z',
      },
    ]);
    const { runner } = fakeRunner({ symbols: ['parseThing'] });
    const { dependencies: deps, log } = dependencies(
      { issues: [issue('COR-1', goodBody, 'In Progress')] },
      {
        runner: (command) =>
          command[0] === 'gh' ? { code: 0, stdout: prs, stderr: '' } : runner(command),
      },
    );
    const result = await run(['stale', '--json'], deps);
    const parsed = JSON.parse(result.output);
    expect(result.code).toBe(1);
    expect(parsed.issues[0].action).toBe('propose-close');
    expect(log[0]?.variables['filter'].state).toEqual({ type: { nin: ['completed', 'canceled'] } });
  });

  test('stale reads referenced issue state once per identifier', async () => {
    const body = goodBody.replace('(COR-5 decision).', '(COR-5 decision, COR-5 again).');
    const { dependencies: deps, log } = dependencies({
      issues: [issue('COR-1', body), issue('COR-2', body)],
    });
    const result = await run(['stale'], deps);
    expect(result.output).toContain('referenced-closed: COR-5 is referenced but is already Done.');
    expect(log.filter((entry) => entry.operation === 'TriageReferenced').length).toBe(1);
  });

  test('a gh failure is reported with exit 1 and no triage', async () => {
    const { dependencies: deps } = dependencies(
      { issues: [issue('COR-1', goodBody)] },
      { runner: () => ({ code: 1, stdout: '', stderr: 'not signed in' }) },
    );
    const result = await run(['stale'], deps);
    expect(result.code).toBe(1);
    expect(result.output).toContain('gh pr list failed');
  });

  test('Linear unavailable is exit 3, including a missing key', async () => {
    const down = dependencies({ fail: true });
    const unreachable = await run(['ready'], down.dependencies);
    expect(unreachable.code).toBe(3);
    const keyless = dependencies({}, { environment: {}, resolveKey: () => undefined });
    const result = await run(['ready'], keyless.dependencies);
    expect(result.code).toBe(3);
    expect(result.output).toContain('LINEAR_API_KEY is unavailable');
  });

  test('usage errors', async () => {
    const { dependencies: deps } = dependencies({});
    for (const argv of [
      [],
      ['bogus'],
      ['ready', 'extra'],
      ['ready', '--since', '2026-01-01'],
      ['done', '--state', 'Done'],
      ['done', '--issue', 'COR-1'],
      ['ready', '--jev', 'on'],
      ['ready', '--limit', '0'],
      ['ready', '--issue', 'nope'],
      ['done', '--since', 'yesterday-ish'],
    ])
      expect(await rejectionOf(run(argv, deps))).toBeInstanceOf(UsageError);
  });
});
