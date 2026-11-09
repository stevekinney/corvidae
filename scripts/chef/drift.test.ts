import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  findDrift,
  mentions,
  PULL_REQUEST_LIMIT,
  run,
  type DriftDependencies,
  type OpenIssue,
  type PullRequest,
} from './drift.ts';
import type { FetchLike } from './linear.ts';
import { UsageError, type Runner } from './process-runner.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

interface FakeIssue {
  identifier: string;
  updatedAt: string;
  state: { name: string; type: string };
}

const todo = { name: 'Todo', type: 'unstarted' };
const doing = { name: 'In Progress', type: 'started' };
const review = { name: 'In Review', type: 'started' };

function issue(identifier: string, state: FakeIssue['state'], updatedAt = daysAgo(0)): FakeIssue {
  return { identifier, updatedAt, state };
}

/** A fake Linear that serves one team, optionally one project, in pages, and records every request. */
function fakeLinear(issues: FakeIssue[], options: { pageSize?: number; projects?: string[] } = {}) {
  const log: { operation: string; query: string; variables: Record<string, any> }[] = [];
  const pageSize = options.pageSize ?? 100;
  const fetchLike: FetchLike = async (_url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
      query: string;
      variables: Record<string, any>;
    };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? '';
    log.push({ operation, query: body.query, variables: body.variables });
    switch (operation) {
      case 'DriftTeam':
        return Response.json({
          data: {
            teams: { nodes: body.variables['filter'].key.eq === 'COR' ? [{ id: 'team-cor' }] : [] },
          },
        });
      case 'DriftProject':
        return Response.json({
          data: {
            projects: {
              nodes: (options.projects ?? ['proj-1']).includes(body.variables['filter'].id.eq)
                ? [{ id: body.variables['filter'].id.eq }]
                : [],
            },
          },
        });
      case 'DriftIssues': {
        const start = body.variables['after'] === null ? 0 : Number(body.variables['after']);
        const nodes = issues.slice(start, start + pageSize);
        const next = start + pageSize;
        return Response.json({
          data: {
            issues: {
              nodes,
              pageInfo: {
                hasNextPage: next < issues.length,
                endCursor: next < issues.length ? String(next) : null,
              },
            },
          },
        });
      }
      default:
        return Response.json({ errors: [{ message: `unexpected ${operation}` }] });
    }
  };
  return { fetch: fetchLike, log };
}

interface FakePullRequest {
  number: number;
  title?: string;
  headRefName?: string;
  body?: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string | null;
  updatedAt?: string;
}

function pullRequest(fields: FakePullRequest): PullRequest & { updatedAt: string } {
  return {
    title: '',
    headRefName: 'branch',
    body: '',
    mergedAt: fields.state === 'MERGED' ? daysAgo(1) : null,
    updatedAt: daysAgo(1),
    ...fields,
  };
}

function fakeRunner(result: { code?: number; stdout?: string; stderr?: string }) {
  const commands: string[][] = [];
  const runner: Runner = (command) => {
    commands.push(command);
    return { code: result.code ?? 0, stdout: result.stdout ?? '[]', stderr: result.stderr ?? '' };
  };
  return { runner, commands };
}

function setup(
  issues: FakeIssue[],
  pullRequests: object[],
  options: { pageSize?: number; projects?: string[] } = {},
) {
  const linear = fakeLinear(issues, options);
  const github = fakeRunner({ stdout: JSON.stringify(pullRequests) });
  const dependencies: DriftDependencies = {
    fetch: linear.fetch,
    environment: { LINEAR_API_KEY: 'lin_api_test_secret_value' },
    runner: github.runner,
    now: () => NOW,
  };
  return { linear, github, dependencies };
}

describe('whole-token matching', () => {
  test('COR-12 does not match COR-123 or a longer prefix, and matches in a branch name', () => {
    expect(mentions('COR-123: add a thing', 'COR-12')).toBe(false);
    expect(mentions('see XCOR-12', 'COR-12')).toBe(false);
    expect(mentions('COR-12: add a thing', 'COR-12')).toBe(true);
    expect(mentions('worktree/cor-12-drift', 'COR-12')).toBe(true);
    expect(mentions('Closes COR-12.', 'COR-12')).toBe(true);
    expect(mentions('(COR-12)', 'COR-12')).toBe(true);
    expect(mentions('', 'COR-12')).toBe(false);
  });

  test('a pull request naming COR-123 never gives COR-12 a finding', async () => {
    const { dependencies } = setup(
      [issue('COR-12', doing)],
      [pullRequest({ number: 7, title: 'COR-123: other work', state: 'MERGED' })],
    );
    const result = await run(['--json'], dependencies);
    expect(result.code).toBe(0);
    expect(result.output).toContain('"findings":[]');
  });

  test('the title, branch name and body each attach a pull request to an issue', () => {
    const issues: OpenIssue[] = [issue('COR-1', todo), issue('COR-2', todo), issue('COR-3', todo)];
    const pullRequests = [
      pullRequest({ number: 1, title: 'COR-1: x', state: 'MERGED' }),
      pullRequest({ number: 2, headRefName: 'cor-2-x', state: 'MERGED' }),
      pullRequest({ number: 3, body: 'Closes COR-3', state: 'MERGED' }),
    ];
    expect(
      findDrift(issues, pullRequests, NOW, 3).map((finding) => [
        finding.identifier,
        finding.pullRequest,
      ]),
    ).toEqual([
      ['COR-1', 1],
      ['COR-2', 2],
      ['COR-3', 3],
    ]);
  });
});

describe('findings', () => {
  test('merged-open: an open issue whose pull request merged, naming the latest one', async () => {
    const { dependencies } = setup(
      [issue('COR-1', todo)],
      [
        pullRequest({ number: 5, title: 'COR-1: a', state: 'MERGED' }),
        pullRequest({ number: 9, title: 'COR-1: b', state: 'MERGED' }),
      ],
    );
    const result = await run([], dependencies);
    expect(result.code).toBe(1);
    expect(result.output).toContain('COR-1 merged-open state=Todo pr=#9');
    expect(result.output).not.toContain('#5');
  });

  test('merged-open: a pull request with a mergedAt counts as merged whatever its state field says', () => {
    const findings = findDrift(
      [issue('COR-1', todo)],
      [pullRequest({ number: 4, title: 'COR-1', state: 'CLOSED', mergedAt: daysAgo(2) })],
      NOW,
      3,
    );
    expect(findings.map((finding) => finding.kind)).toEqual(['merged-open']);
  });

  test('a closed, unmerged pull request is not a merge', () => {
    expect(
      findDrift(
        [issue('COR-1', todo)],
        [pullRequest({ number: 4, title: 'COR-1', state: 'CLOSED' })],
        NOW,
        3,
      ),
    ).toEqual([]);
  });

  test('review-without-pr: In Review, matched by name, with no open pull request', async () => {
    const { dependencies } = setup(
      [issue('COR-2', review), issue('COR-3', review)],
      [pullRequest({ number: 8, title: 'COR-3: ok', state: 'OPEN' })],
    );
    const result = await run(['--json'], dependencies);
    const report = JSON.parse(result.output);
    expect(result.code).toBe(1);
    expect(report.findings).toEqual([
      { identifier: 'COR-2', kind: 'review-without-pr', state: 'In Review', pullRequest: null },
    ]);
  });

  test('review-without-pr: a closed pull request does not count as one to review', () => {
    const findings = findDrift(
      [issue('COR-2', review)],
      [pullRequest({ number: 8, title: 'COR-2', state: 'CLOSED' })],
      NOW,
      3,
    );
    expect(findings.map((finding) => finding.kind)).toEqual(['review-without-pr']);
  });

  test('review-without-pr: the state is matched by name, ignoring case', () => {
    const findings = findDrift(
      [issue('COR-2', { name: ' in review ', type: 'started' })],
      [],
      NOW,
      3,
    );
    expect(findings.map((finding) => finding.kind)).toEqual(['review-without-pr']);
  });

  test('stale-in-progress: started, no open pull request and quiet for more than three days', () => {
    const issues = [
      issue('COR-1', doing, daysAgo(4)),
      issue('COR-2', doing, daysAgo(2)),
      issue('COR-3', doing, daysAgo(3)),
      issue('COR-4', doing, daysAgo(10)),
      issue('COR-5', todo, daysAgo(10)),
    ];
    const findings = findDrift(
      issues,
      [pullRequest({ number: 1, title: 'COR-4: wip', state: 'OPEN' })],
      NOW,
      3,
    );
    expect(findings).toEqual([
      { identifier: 'COR-1', kind: 'stale-in-progress', state: 'In Progress', pullRequest: null },
    ]);
  });

  test('stale-in-progress: an In Review issue is never stale, and --stale-days moves the line', async () => {
    const issues = [issue('COR-1', doing, daysAgo(4)), issue('COR-2', review, daysAgo(20))];
    const defaults = await run(['--json'], setup(issues, []).dependencies);
    expect(
      JSON.parse(defaults.output).findings.map((f: { identifier: string; kind: string }) => [
        f.identifier,
        f.kind,
      ]),
    ).toEqual([
      ['COR-1', 'stale-in-progress'],
      ['COR-2', 'review-without-pr'],
    ]);
    const lenient = await run(['--json', '--stale-days', '5'], setup(issues, []).dependencies);
    expect(JSON.parse(lenient.output).findings.map((f: { kind: string }) => f.kind)).toEqual([
      'review-without-pr',
    ]);
  });

  test('stale-in-progress: the injected clock decides, not the host clock', () => {
    const issues = [issue('COR-1', doing, daysAgo(4))];
    expect(findDrift(issues, [], NOW, 3)).toHaveLength(1);
    expect(findDrift(issues, [], new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000), 3)).toEqual([]);
  });

  test('one issue can carry more than one kind, listed in identifier order', () => {
    const findings = findDrift(
      [issue('COR-10', review), issue('COR-9', review)],
      [pullRequest({ number: 2, title: 'COR-10', state: 'MERGED' })],
      NOW,
      3,
    );
    expect(findings.map((finding) => `${finding.identifier} ${finding.kind}`)).toEqual([
      'COR-9 review-without-pr',
      'COR-10 merged-open',
      'COR-10 review-without-pr',
    ]);
  });
});

describe('the report', () => {
  test('a clean report is "No drift." with exit 0', async () => {
    const { dependencies } = setup(
      [issue('COR-1', doing), issue('COR-2', review)],
      [pullRequest({ number: 3, title: 'COR-2: ok', state: 'OPEN' })],
    );
    expect(await run([], dependencies)).toEqual({ code: 0, output: 'No drift.' });
    const jsonResult = await run(['--json'], dependencies);
    const json = JSON.parse(jsonResult.output);
    expect(json).toMatchObject({ ok: true, findings: [], truncated: false });
  });

  test('exit 1 lists each finding with identifier, kind, state and the pull request number', async () => {
    const { dependencies } = setup(
      [issue('COR-1', todo), issue('COR-2', review), issue('COR-3', doing, daysAgo(9))],
      [pullRequest({ number: 6, title: 'COR-1: done', state: 'MERGED' })],
    );
    const result = await run([], dependencies);
    expect(result.code).toBe(1);
    expect(result.output.split('\n')).toEqual([
      'Drift: 3 findings across 3 open issues.',
      'COR-1 merged-open state=Todo pr=#6',
      'COR-2 review-without-pr state=In Review',
      'COR-3 stale-in-progress state=In Progress',
    ]);
  });

  test('--json carries the findings on exit 1', async () => {
    const { dependencies } = setup(
      [issue('COR-1', todo)],
      [pullRequest({ number: 6, title: 'COR-1', state: 'MERGED' })],
    );
    const result = await run(['--json'], dependencies);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      findings: [{ identifier: 'COR-1', kind: 'merged-open', state: 'Todo', pullRequest: 6 }],
    });
  });

  test('a null pull-request body is read as empty', async () => {
    const { dependencies } = setup(
      [issue('COR-1', todo)],
      [{ ...pullRequest({ number: 6, title: 'COR-1', state: 'MERGED' }), body: null }],
    );
    const result = await run([], dependencies);
    expect(result.code).toBe(1);
  });

  test('a result as long as the gh limit says older pull requests were not considered', async () => {
    const many = Array.from({ length: PULL_REQUEST_LIMIT }, (_, index) =>
      pullRequest({ number: index + 1, title: 'unrelated', state: 'CLOSED' }),
    );
    const { dependencies } = setup([issue('COR-1', todo)], many);
    const result = await run([], dependencies);
    expect(result.code).toBe(0);
    expect(result.output).toContain('No drift.');
    expect(result.output).toContain('older ones were not considered');
    const jsonResult = await run(['--json'], dependencies);
    expect(JSON.parse(jsonResult.output).truncated).toBe(true);
  });
});

describe('reading', () => {
  test('follows Linear pagination to the last page', async () => {
    const issues = Array.from({ length: 5 }, (_, index) => issue(`COR-${index + 1}`, todo));
    const { dependencies, linear } = setup(
      issues,
      issues.map((entry, index) =>
        pullRequest({ number: index + 1, title: entry.identifier, state: 'MERGED' }),
      ),
      { pageSize: 2 },
    );
    const result = await run(['--json'], dependencies);
    expect(JSON.parse(result.output).findings).toHaveLength(5);
    const pages = linear.log.filter((entry) => entry.operation === 'DriftIssues');
    expect(pages.map((entry) => entry.variables['after'])).toEqual([null, '2', '4']);
  });

  test('asks Linear for open issues of the team, or of the project when one is named', async () => {
    const first = setup([issue('COR-1', todo)], []);
    await run([], first.dependencies);
    const teamPage = first.linear.log.find((entry) => entry.operation === 'DriftIssues');
    expect(teamPage?.variables['filter']).toEqual({
      team: { key: { eq: 'COR' } },
      state: { type: { nin: ['completed', 'canceled'] } },
    });
    const second = setup([issue('COR-1', todo)], []);
    await run(['--team', 'COR', '--project', 'proj-1'], second.dependencies);
    const projectPage = second.linear.log.find((entry) => entry.operation === 'DriftIssues');
    expect(projectPage?.variables['filter'].project).toEqual({ id: { eq: 'proj-1' } });
  });

  test('runs the documented gh command through the runner', async () => {
    const { dependencies, github } = setup([issue('COR-1', todo)], []);
    await run([], dependencies);
    expect(github.commands).toEqual([
      [
        'gh',
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '1000',
        '--json',
        'number,title,headRefName,body,state,mergedAt,updatedAt',
      ],
    ]);
  });

  test('never writes: every Linear request is a query and gh only lists', async () => {
    const { dependencies, linear, github } = setup(
      [issue('COR-1', todo), issue('COR-2', review)],
      [pullRequest({ number: 1, title: 'COR-1', state: 'MERGED' })],
    );
    await run(['--project', 'proj-1'], dependencies);
    expect(linear.log.length).toBeGreaterThan(0);
    expect(linear.log.every((entry) => /^\s*query\s/.test(entry.query))).toBe(true);
    expect(linear.log.some((entry) => /mutation/i.test(entry.query))).toBe(false);
    expect(github.commands.every((command) => command.slice(0, 3).join(' ') === 'gh pr list')).toBe(
      true,
    );
  });
});

describe('failed reads', () => {
  test('a failed gh read is exit 1 naming gh, never "No drift."', async () => {
    const { dependencies } = setup([issue('COR-1', todo)], []);
    const failing = fakeRunner({ code: 1, stderr: 'gh: not logged in\n', stdout: '' });
    const result = await run([], { ...dependencies, runner: failing.runner });
    expect(result.code).toBe(1);
    expect(result.output).toContain('gh read failed');
    expect(result.output).toContain('not logged in');
    expect(result.output).not.toContain('No drift.');
    const json = await run(['--json'], { ...dependencies, runner: failing.runner });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.output)).toMatchObject({ ok: false, failedRead: 'gh' });
  });

  test('gh output that is not a JSON list is a failed read', async () => {
    const { dependencies } = setup([issue('COR-1', todo)], []);
    for (const stdout of ['not json', '{"number":1}', '[{"title":"no number"}]']) {
      const result = await run([], {
        ...dependencies,
        runner: fakeRunner({ stdout }).runner,
      });
      expect(result.code, stdout).toBe(1);
      expect(result.output, stdout).toContain('gh read failed');
    }
  });

  test('a gh that cannot start is a failed read', async () => {
    const { dependencies } = setup([issue('COR-1', todo)], []);
    const result = await run([], {
      ...dependencies,
      runner: () => {
        throw new Error('spawn gh ENOENT');
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('gh read failed');
  });

  test('a Linear failure is exit 1 naming Linear, and gh is never reached', async () => {
    const { dependencies, github } = setup([issue('COR-1', todo)], []);
    const failing: FetchLike = async () => Response.json({ errors: [{ message: 'boom' }] });
    const result = await run([], { ...dependencies, fetch: failing });
    expect(result.code).toBe(1);
    expect(result.output).toContain('Linear read failed');
    expect(result.output).toContain('boom');
    expect(result.output).not.toContain('No drift.');
    expect(github.commands).toEqual([]);
  });

  test('a failure on a later Linear page is not a partial report', async () => {
    const issues = Array.from({ length: 3 }, (_, index) => issue(`COR-${index + 1}`, todo));
    const linear = fakeLinear(issues, { pageSize: 2 });
    let calls = 0;
    const flaky: FetchLike = async (url, init) => {
      calls += 1;
      return calls >= 3
        ? Response.json({ errors: [{ message: 'page two failed' }] })
        : linear.fetch(url, init);
    };
    const { dependencies } = setup(issues, []);
    const result = await run([], { ...dependencies, fetch: flaky });
    expect(result.code).toBe(1);
    expect(result.output).toContain('page two failed');
  });

  test('a mistyped team or project is a failed read, not an empty clean report', async () => {
    const { dependencies } = setup([issue('COR-1', todo)], []);
    const team = await run(['--team', 'NOPE'], dependencies);
    expect(team.code).toBe(1);
    expect(team.output).toContain('No team NOPE.');
    const project = await run(['--project', 'missing'], dependencies);
    expect(project.code).toBe(1);
    expect(project.output).toContain('No project missing.');
  });
});

describe('usage', () => {
  test('rejects an unknown option, a stray argument and a bad --stale-days with a usage error', async () => {
    const { dependencies } = setup([], []);
    for (const argv of [
      ['--nope'],
      ['COR-1'],
      ['--stale-days', 'soon'],
      ['--stale-days', '-1'],
      ['--stale-days'],
      ['--team', ''],
      ['--project', ''],
    ]) {
      expect(await rejectionOf(run(argv, dependencies)), argv.join(' ')).toBeInstanceOf(UsageError);
    }
  });

  test('makes no request before a usage error', async () => {
    const { dependencies, linear, github } = setup([], []);
    await rejectionOf(run(['--stale-days', 'soon'], dependencies));
    expect(linear.log).toEqual([]);
    expect(github.commands).toEqual([]);
  });

  test('an unavailable LINEAR_API_KEY is a usage error that never prints a value', async () => {
    const { dependencies } = setup([], []);
    const error = await rejectionOf(
      run([], { ...dependencies, environment: {}, resolveKey: () => undefined }),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('LINEAR_API_KEY');
  });
});
