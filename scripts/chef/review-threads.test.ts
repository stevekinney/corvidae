import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listThreads,
  parseReplies,
  parseRepository,
  resolveThreads,
  run,
  type Runner,
  UsageError,
} from './review-threads.ts';

interface FakeThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  databaseId: number | null;
  author: string;
  body: string;
}

function makeThreads(count: number, resolvedEvery = 0): FakeThread[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `T${index + 1}`,
    isResolved: resolvedEvery > 0 && (index + 1) % resolvedEvery === 0,
    path: `src/file-${index + 1}.ts`,
    line: index + 1,
    databaseId: 1000 + index + 1,
    author: 'reviewer',
    body: `Finding ${index + 1}\nmore detail`,
  }));
}

/** A fake `gh`: serves `reviewThreads` 50 at a time, records replies, and resolves on request. */
function fakeGitHub(
  threads: FakeThread[],
  options: {
    totalOverride?: number;
    failReplyFor?: string;
    failResolveFor?: string;
    ignoreResolve?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const replies: { endpoint: string; body: string }[] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    const field = (key: string): string | undefined =>
      command.find((word) => word.startsWith(`${key}=`))?.slice(key.length + 1);
    if (command[1] === 'api' && command[2] === 'graphql') {
      const query = field('query') ?? '';
      if (query.includes('resolveReviewThread')) {
        const id = field('id')!;
        if (id === options.failResolveFor) return { code: 1, stdout: '', stderr: 'HTTP 502' };
        if (!options.ignoreResolve) threads.find((thread) => thread.id === id)!.isResolved = true;
        return {
          code: 0,
          stdout: JSON.stringify({
            data: { resolveReviewThread: { thread: { id, isResolved: true } } },
          }),
          stderr: '',
        };
      }
      const after = field('after');
      const start = after === undefined ? 0 : Number(after.replace('cursor-', ''));
      const page = threads.slice(start, start + 50);
      const hasNextPage = start + 50 < threads.length;
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  totalCount: options.totalOverride ?? threads.length,
                  pageInfo: {
                    hasNextPage,
                    endCursor: hasNextPage ? `cursor-${start + 50}` : null,
                  },
                  nodes: page.map((thread) => ({
                    id: thread.id,
                    isResolved: thread.isResolved,
                    path: thread.path,
                    line: thread.line,
                    originalLine: null,
                    comments: {
                      nodes:
                        thread.databaseId === null
                          ? []
                          : [
                              {
                                databaseId: thread.databaseId,
                                body: thread.body,
                                author: { login: thread.author },
                              },
                            ],
                    },
                  })),
                },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    if (command[1] === 'api' && command[2] === '-X') {
      const endpoint = command[4]!;
      const body = field('body')!;
      const databaseId = Number(/comments\/(\d+)\/replies$/.exec(endpoint)![1]);
      const thread = threads.find((candidate) => candidate.databaseId === databaseId)!;
      if (thread.id === options.failReplyFor)
        return { code: 1, stdout: '', stderr: 'HTTP 422 Validation Failed' };
      replies.push({ endpoint, body });
      return { code: 0, stdout: '{}', stderr: '' };
    }
    throw new Error(`fake gh: unhandled ${command.join(' ')}`);
  };
  return { runner, calls, replies };
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'review-threads-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const path = join(sandbox, name);
  writeFileSync(path, content);
  return path;
}

describe('listThreads', () => {
  test('follows pageInfo across pages and sees every thread', () => {
    const fake = fakeGitHub(makeThreads(120, 4));
    const listing = listThreads('acme/widgets', 7, fake.runner);
    expect(listing.seen).toBe(120);
    expect(listing.total).toBe(120);
    expect(listing.unresolved).toBe(90);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]).toContain('pr=7');
    expect(fake.calls[0]).toContain('owner=acme');
    expect(fake.calls[1]).toContain('after=cursor-50');
    expect(fake.calls[0]?.join(' ')).toContain('first: 50');
  });

  test('carries the id, first comment databaseId, location, author and first line', () => {
    const listing = listThreads('acme/widgets', 7, fakeGitHub(makeThreads(2)).runner);
    expect(listing.threads[0]).toEqual({
      id: 'T1',
      isResolved: false,
      path: 'src/file-1.ts',
      line: 1,
      author: 'reviewer',
      commentId: 1001,
      firstLine: 'Finding 1',
    });
  });

  test('raises on a gh failure, malformed JSON and a missing pull request', () => {
    expect(() =>
      listThreads('acme/widgets', 7, () => ({
        code: 1,
        stdout: '',
        stderr: 'HTTP 404',
      })),
    ).toThrow('HTTP 404');
    expect(() =>
      listThreads('acme/widgets', 7, () => ({
        code: 0,
        stdout: 'not json',
        stderr: '',
      })),
    ).toThrow('not JSON');
    expect(() =>
      listThreads('acme/widgets', 7, () => ({
        code: 0,
        stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }),
        stderr: '',
      })),
    ).toThrow('no review thread listing');
  });

  test('refuses a page that repeats its cursor', () => {
    const stuck: Runner = () => ({
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 100,
                pageInfo: { hasNextPage: true, endCursor: 'same' },
                nodes: [],
              },
            },
          },
        },
      }),
      stderr: '',
    });
    expect(() => listThreads('acme/widgets', 7, stuck)).toThrow('without a new cursor');
  });
});

describe('list', () => {
  test('prints a line per thread and a SEEN/TOTAL/UNRESOLVED summary, exiting 0 when complete', () => {
    const result = run(['list', 'acme/widgets', '7'], {
      runner: fakeGitHub(makeThreads(3, 3)).runner,
    });
    expect(result.code).toBe(0);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('T1 1001 src/file-1.ts:1 @reviewer open  Finding 1');
    expect(lines[2]).toContain('resolved');
    expect(lines.at(-1)).toBe('SEEN=3 TOTAL=3 UNRESOLVED=2');
  });

  test('exits 1 when SEEN does not equal TOTAL', () => {
    const result = run(['list', 'acme/widgets', '7'], {
      runner: fakeGitHub(makeThreads(3), { totalOverride: 5 }).runner,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('SEEN=3 TOTAL=5 UNRESOLVED=3');
    expect(result.output).toContain('incomplete');
    expect(
      JSON.parse(
        run(['list', 'acme/widgets', '7', '--json'], {
          runner: fakeGitHub(makeThreads(3), { totalOverride: 5 }).runner,
        }).output,
      ).complete,
    ).toBe(false);
  });

  test('--unresolved hides resolved threads but keeps the totals', () => {
    const result = run(['list', 'acme/widgets', '7', '--unresolved'], {
      runner: fakeGitHub(makeThreads(4, 2)).runner,
    });
    expect(result.output.split('\n')).toHaveLength(3);
    expect(result.output).not.toContain('resolved ');
    expect(result.output.split('\n').at(-1)).toBe('SEEN=4 TOTAL=4 UNRESOLVED=2');
  });

  test('turns a gh failure into exit 1', () => {
    const result = run(['list', 'acme/widgets', '7'], {
      runner: () => ({ code: 1, stdout: '', stderr: 'auth required' }),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('auth required');
  });
});

describe('parseReplies', () => {
  test('splits on the first tab, expands \\n and skips blank lines', () => {
    expect(parseReplies('T1\tFixed in abc.\\nThanks\n\nT2\tDeclined: one-off\n')).toEqual([
      { threadId: 'T1', reply: 'Fixed in abc.\nThanks' },
      { threadId: 'T2', reply: 'Declined: one-off' },
    ]);
  });

  test('rejects a missing reply and a repeated thread', () => {
    expect(() => parseReplies('T1\n')).toThrow(UsageError);
    expect(() => parseReplies('T1\tok\nT1\tagain\n')).toThrow(UsageError);
  });
});

describe('resolve', () => {
  test("replies by the thread's first comment id, resolves, re-lists and reports RESOLVED n/n", () => {
    const fake = fakeGitHub(makeThreads(3));
    const result = run(
      ['resolve', 'acme/widgets', '7', '--file', file('r.tsv', 'T1\tDone\nT3\tDeclined\n')],
      { runner: fake.runner },
    );
    expect(result.code).toBe(0);
    expect(result.output.split('\n')[0]).toBe(
      'RESOLVED 2/2  remaining unresolved on the pull request: 1',
    );
    expect(fake.replies).toEqual([
      {
        endpoint: 'repos/acme/widgets/pulls/7/comments/1001/replies',
        body: 'Done',
      },
      {
        endpoint: 'repos/acme/widgets/pulls/7/comments/1003/replies',
        body: 'Declined',
      },
    ]);
  });

  test('keys by thread id: an unknown id fails by id and posts nothing', () => {
    const fake = fakeGitHub(makeThreads(2));
    const result = run(
      [
        'resolve',
        'acme/widgets',
        '7',
        '--file',
        file('r.tsv', '1001\tcomment id, not thread id\n'),
      ],
      { runner: fake.runner },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('FAILED 1001: no such review thread');
    expect(fake.replies).toHaveLength(0);
  });

  test('a failed reply leaves the thread open and unresolved, and is reported by thread id', () => {
    const fake = fakeGitHub(makeThreads(2), { failReplyFor: 'T1' });
    const report = resolveThreads(
      'acme/widgets',
      7,
      [
        { threadId: 'T1', reply: 'x' },
        { threadId: 'T2', reply: 'y' },
      ],
      fake.runner,
    );
    expect(report.resolved).toBe(1);
    expect(report.failures).toEqual([
      { threadId: 'T1', reason: 'reply failed: HTTP 422 Validation Failed' },
    ]);
    expect(report.remainingUnresolved).toBe(1);
    expect(
      fake.calls.filter(
        (call) => (call[call.length - 2] ?? '') === '-f' && call.join(' ').includes('id=T1'),
      ),
    ).toHaveLength(0);
  });

  test('exits 1 when the mutation fails or the thread is unresolved on the re-list', () => {
    const failed = fakeGitHub(makeThreads(1), { failResolveFor: 'T1' });
    const one = run(['resolve', 'acme/widgets', '7', '--file', file('r.tsv', 'T1\tok\n')], {
      runner: failed.runner,
    });
    expect(one.code).toBe(1);
    expect(one.output).toContain('FAILED T1: resolve failed');
    const silent = fakeGitHub(makeThreads(1), { ignoreResolve: true });
    const two = run(['resolve', 'acme/widgets', '7', '--file', file('r.tsv', 'T1\tok\n')], {
      runner: silent.runner,
    });
    expect(two.code).toBe(1);
    expect(two.output.split('\n')[0]).toContain('RESOLVED 0/1');
  });

  test('an already-resolved thread counts as resolved without a second reply', () => {
    const fake = fakeGitHub(makeThreads(2, 1));
    const result = run(['resolve', 'acme/widgets', '7', '--file', file('r.tsv', 'T1\tok\n')], {
      runner: fake.runner,
    });
    expect(result.code).toBe(0);
    expect(fake.replies).toHaveLength(0);
  });

  test('exits 1 when the final re-list is incomplete', () => {
    const fake = fakeGitHub(makeThreads(2), { totalOverride: 9 });
    expect(
      run(['resolve', 'acme/widgets', '7', '--file', file('r.tsv', 'T1\tok\n')], {
        runner: fake.runner,
      }).code,
    ).toBe(1);
  });
});

describe('usage', () => {
  test('rejects bad arguments', () => {
    const runner = fakeGitHub([]).runner;
    expect(() => run([], { runner })).toThrow(UsageError);
    expect(() => run(['nope'], { runner })).toThrow(UsageError);
    expect(() => run(['list', 'acme', '7'], { runner })).toThrow(UsageError);
    expect(() => run(['list', 'acme/widgets', 'x'], { runner })).toThrow(UsageError);
    expect(() => run(['list', 'acme/widgets'], { runner })).toThrow(UsageError);
    expect(() => run(['list', 'acme/widgets', '7', '--file', 'x'], { runner })).toThrow(UsageError);
    expect(() => run(['resolve', 'acme/widgets', '7'], { runner })).toThrow(UsageError);
    expect(() =>
      run(['resolve', 'acme/widgets', '7', '--file', join(sandbox, 'missing')], { runner }),
    ).toThrow(UsageError);
    expect(() =>
      run(['resolve', 'acme/widgets', '7', '--file', file('empty.tsv', '\n')], {
        runner,
      }),
    ).toThrow(UsageError);
    expect(() => parseRepository('a/b/c')).toThrow(UsageError);
  });
});
