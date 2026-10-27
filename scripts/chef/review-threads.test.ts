import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignRounds,
  type DefectClass,
  listThreads,
  loadDefectClasses,
  parseDefectClasses,
  parseReplies,
  parseRepository,
  resolveThreads,
  type ReviewThread,
  run,
  type Runner,
  summarizeClasses,
  tagText,
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
  createdAt?: string;
  authorType?: string;
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
                                createdAt: thread.createdAt ?? null,
                                author: {
                                  login: thread.author,
                                  __typename: thread.authorType ?? 'User',
                                },
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
      body: 'Finding 1\nmore detail',
      createdAt: null,
      authorIsBot: false,
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

describe('--pr spelling', () => {
  const config = () =>
    file(
      'config.json',
      JSON.stringify({
        repository: 'acme/widgets',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'widgets',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );

  test('list --pr <n> reads the repository from the configuration and matches the positional form', () => {
    const positional = run(['list', 'acme/widgets', '7', '--json'], {
      runner: fakeGitHub(makeThreads(3, 3)).runner,
    });
    const fake = fakeGitHub(makeThreads(3, 3));
    const flagged = run(['list', '--pr', '7', '--config', config(), '--json'], {
      runner: fake.runner,
    });
    expect(flagged.code).toBe(0);
    expect(JSON.parse(flagged.output)).toEqual(JSON.parse(positional.output));
    expect(fake.calls[0]).toContain('owner=acme');
    expect(fake.calls[0]).toContain('name=widgets');
    expect(fake.calls[0]).toContain('pr=7');
  });

  test('list --pr <n> defaults to the checked-in repository.json', () => {
    const fake = fakeGitHub(makeThreads(1));
    expect(run(['list', '--pr', '7', '--unresolved'], { runner: fake.runner }).code).toBe(0);
    expect(fake.calls[0]).toContain('owner=stevekinney');
    expect(fake.calls[0]).toContain('name=corvidae');
  });

  test('--repository and a repository positional both name the repository with --pr', () => {
    const viaFlag = fakeGitHub(makeThreads(1));
    run(['list', '--pr', '7', '--repository', 'acme/gadgets'], { runner: viaFlag.runner });
    expect(viaFlag.calls[0]).toContain('name=gadgets');
    const viaPositional = fakeGitHub(makeThreads(1));
    run(['list', 'acme/gizmos', '--pr', '7'], { runner: viaPositional.runner });
    expect(viaPositional.calls[0]).toContain('name=gizmos');
  });

  test('resolve --pr <n> replies and resolves like the positional form', () => {
    const threads = makeThreads(2);
    const fake = fakeGitHub(threads);
    const result = run(
      [
        'resolve',
        '--pr',
        '7',
        '--repository',
        'acme/widgets',
        '--file',
        file('replies.tsv', 'T1\tfixed in abc\nT2\tdeclined\n'),
      ],
      { runner: fake.runner },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('RESOLVED 2/2');
    expect(fake.replies).toHaveLength(2);
  });

  test('classes accepts the positional form too', () => {
    const result = run(['classes', 'acme/widgets', '7'], {
      runner: fakeGitHub(makeThreads(1)).runner,
    });
    expect(result.code).toBe(0);
  });

  test('refuses an ambiguous or incomplete target as a usage error', () => {
    const runner = fakeGitHub([]).runner;
    expect(() => run(['list', 'acme/widgets', '7', '--pr', '8'], { runner })).toThrow(UsageError);
    expect(() =>
      run(['list', 'acme/widgets', '--pr', '7', '--repository', 'a/b'], { runner }),
    ).toThrow(UsageError);
    expect(() => run(['list', '--pr', 'x'], { runner })).toThrow(UsageError);
    expect(() => run(['list', '--repository', 'acme/widgets'], { runner })).toThrow(UsageError);
    expect(() => run(['list', '--pr', '7', 'a/b', 'extra'], { runner })).toThrow(UsageError);
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

/** A bot-authored thread posted at `createdAt`, as GitHub would list it. */
function botThread(index: number, body: string, createdAt: string, bot = true): FakeThread {
  return {
    id: `T${index}`,
    isResolved: false,
    path: 'src/a.ts',
    line: index,
    databaseId: 2000 + index,
    author: bot ? 'review-bot[bot]' : 'steve',
    authorType: bot ? 'Bot' : 'User',
    body,
    createdAt,
  };
}

function asThread(fake: FakeThread): ReviewThread {
  return {
    id: fake.id,
    isResolved: fake.isResolved,
    path: fake.path,
    line: fake.line,
    author: fake.author,
    commentId: fake.databaseId,
    firstLine: fake.body,
    body: fake.body,
    createdAt: fake.createdAt ?? null,
    authorIsBot: fake.authorType === 'Bot',
  };
}

describe('defect classes', () => {
  const classes = loadDefectClasses();

  test('the shipped file defines the ten classes with valid patterns', () => {
    expect(classes.map((defectClass) => defectClass.name)).toEqual([
      'adapter-drop',
      'pre-commit-exposure',
      'unfenced-check-then-act',
      'stale-generation',
      'receipt-mismatch',
      'missing-authorization',
      'boundary-validation',
      'unsnapshotted-input',
      'spec-contradiction',
      'state-machine',
    ]);
    for (const defectClass of classes) {
      expect(defectClass.description).not.toBe('');
      expect(defectClass.patterns.length).toBeGreaterThan(0);
    }
  });

  test('each class tags its own typical finding, case-insensitively', () => {
    const findings: [string, string][] = [
      [
        'state-machine',
        'A retry after the task already settled runs the shutdown path twice, and the run never leaves its running state.',
      ],
      ['adapter-drop', 'The projection DROPS the metadata field when it maps to the wire format.'],
      ['pre-commit-exposure', 'This publishes the event before the transaction commits.'],
      ['unfenced-check-then-act', 'A classic check-then-act race: two callers can both pass.'],
      ['stale-generation', 'Cleanup runs against a stale generation after the worker restarts.'],
      [
        'receipt-mismatch',
        'A retry with the same key replays a different operation than the receipt.',
      ],
      [
        'missing-authorization',
        "There is no authorization check, so any caller can cancel another tenant's run.",
      ],
      ['boundary-validation', 'This accepts a negative timeout, and NaN is never rejected.'],
      [
        'unsnapshotted-input',
        'The options are read again after the await, so the caller can mutate them.',
      ],
      ['spec-contradiction', 'This contradicts the spec, which says the run must be cancelled.'],
    ];
    for (const [name, finding] of findings) {
      expect(tagText(finding, classes)).toContain(name);
    }
    expect(tagText('Rename this variable for clarity.', classes)).toEqual([]);
  });

  test('one comment can carry several classes', () => {
    const tags = tagText(
      'Missing authorization here, and the retry replays a different payload than its receipt.',
      classes,
    );
    expect(tags).toContain('missing-authorization');
    expect(tags).toContain('receipt-mismatch');
  });

  test('rejects a malformed class file', () => {
    expect(() => parseDefectClasses('nope', 'x.json')).toThrow('not JSON');
    expect(() => parseDefectClasses('{"classes":[]}', 'x.json')).toThrow('non-empty');
    expect(() => parseDefectClasses('{"classes":[{"patterns":["a"]}]}', 'x.json')).toThrow(
      'needs a name',
    );
    expect(() => parseDefectClasses('{"classes":[{"name":"a","patterns":[]}]}', 'x.json')).toThrow(
      'patterns',
    );
    expect(() =>
      parseDefectClasses('{"classes":[{"name":"a","patterns":["("]}]}', 'x.json'),
    ).toThrow('invalid pattern');
    expect(() =>
      parseDefectClasses(
        '{"classes":[{"name":"a","patterns":["a"]},{"name":"a","patterns":["b"]}]}',
        'x.json',
      ),
    ).toThrow('repeats');
    expect(() => loadDefectClasses(join(sandbox, 'missing.json'))).toThrow(UsageError);
  });
});

describe('assignRounds', () => {
  test('starts a new round only after a gap of more than ten minutes between bot comments', () => {
    const threads = [
      botThread(1, 'a', '2026-10-22T12:00:00Z'),
      botThread(2, 'b', '2026-10-22T12:09:59Z'),
      // A human's comment in the middle neither joins nor splits a round.
      botThread(3, 'c', '2026-10-22T12:30:00Z', false),
      botThread(4, 'd', '2026-10-22T12:19:59Z'),
      botThread(5, 'e', '2026-10-22T12:40:00Z'),
      botThread(6, 'f', '2026-10-22T12:50:00Z'),
      botThread(7, 'g', '2026-10-22T13:00:01Z'),
    ].map(asThread);
    const rounds = assignRounds(threads);
    expect([...rounds.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['T1', 1],
      ['T2', 1],
      ['T4', 1],
      ['T5', 2],
      ['T6', 2],
      ['T7', 3],
    ]);
  });

  test('leaves out a bot thread without a readable time', () => {
    const thread = asThread(botThread(1, 'a', 'not a date'));
    expect(assignRounds([thread, { ...thread, id: 'T2', createdAt: null }]).size).toBe(0);
  });
});

describe('summarizeClasses', () => {
  const classes: DefectClass[] = [
    { name: 'race', description: '', patterns: [/\brace\b/i] },
    { name: 'auth', description: '', patterns: [/\bauthorization\b/i] },
  ];

  test('counts threads per class and lists each class once per round', () => {
    const threads = [
      botThread(1, 'A race here', '2026-10-22T12:00:00Z'),
      botThread(2, 'Another RACE there', '2026-10-22T12:02:00Z'),
      botThread(3, 'Missing authorization', '2026-10-22T12:03:00Z'),
      botThread(4, 'Nit: naming', '2026-10-22T12:04:00Z'),
    ].map(asThread);
    expect(summarizeClasses(threads, classes)).toEqual({
      rounds: 1,
      classes: [
        { name: 'race', threads: 2, rounds: [1], repeating: false },
        { name: 'auth', threads: 1, rounds: [1], repeating: false },
      ],
      untagged: 1,
      repeating: [],
    });
  });

  test('a class in two distinct rounds repeats; one round twice does not', () => {
    const threads = [
      botThread(1, 'A race here', '2026-10-22T12:00:00Z'),
      botThread(2, 'Missing authorization', '2026-10-22T12:01:00Z'),
      botThread(3, 'Missing authorization again', '2026-10-22T12:02:00Z'),
      botThread(4, 'The race is back', '2026-10-22T13:00:00Z'),
    ].map(asThread);
    const report = summarizeClasses(threads, classes);
    expect(report.rounds).toBe(2);
    expect(report.repeating).toEqual(['race']);
    expect(report.classes[0]).toEqual({
      name: 'race',
      threads: 2,
      rounds: [1, 2],
      repeating: true,
    });
    expect(report.classes[1]?.repeating).toBe(false);
  });

  test('a human-authored thread is tagged but belongs to no round', () => {
    const threads = [
      botThread(1, 'A race here', '2026-10-22T12:00:00Z'),
      botThread(2, 'A race there', '2026-10-22T14:00:00Z', false),
    ].map(asThread);
    const report = summarizeClasses(threads, classes);
    expect(report.classes[0]).toEqual({ name: 'race', threads: 2, rounds: [1], repeating: false });
  });
});

describe('classes', () => {
  const repeating = [
    botThread(1, 'This is a check-then-act race.', '2026-10-22T12:00:00Z'),
    botThread(2, 'Cleanup uses a stale generation.', '2026-10-22T12:01:00Z'),
    botThread(3, 'Still a race: two callers interleave.', '2026-10-22T13:00:00Z'),
  ];

  test('prints the thread count and rounds per class, and exits 1 when a class repeats', () => {
    const result = run(['classes', '--pr', '7', '--repository', 'acme/widgets'], {
      runner: fakeGitHub(structuredClone(repeating)).runner,
    });
    expect(result.code).toBe(1);
    const lines = result.output.split('\n');
    expect(lines).toContain('unfenced-check-then-act: 2 threads, rounds 1, 2  REPEATING');
    expect(lines).toContain('stale-generation: 1 thread, round 1');
    expect(lines).toContain('adapter-drop: 0 threads');
    expect(result.output).toContain('Stop patching instances and reassess the shared cause.');
  });

  test('exits 0 when no class appears in two rounds', () => {
    const result = run(['classes', '--pr', '7', '--repository', 'acme/widgets'], {
      runner: fakeGitHub(structuredClone(repeating).slice(0, 2)).runner,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('No class repeats across rounds.');
  });

  test('--json carries the report and ok; the repository comes from the configuration', () => {
    const config = file(
      'config.json',
      JSON.stringify({
        repository: 'acme/widgets',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'widgets',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    const fake = fakeGitHub(structuredClone(repeating));
    const result = run(['classes', '--pr', '7', '--config', config, '--json'], {
      runner: fake.runner,
    });
    const parsed = JSON.parse(result.output);
    expect(result.code).toBe(1);
    expect(fake.calls[0]).toContain('owner=acme');
    expect(parsed).toMatchObject({
      repository: 'acme/widgets',
      pr: 7,
      ok: false,
      complete: true,
      rounds: 2,
      untagged: 0,
      repeating: ['unfenced-check-then-act'],
    });
  });

  test('exits 1 when the listing is incomplete or GitHub fails, and 2 on bad usage', () => {
    const incomplete = run(['classes', '--pr', '7', '--repository', 'acme/widgets'], {
      runner: fakeGitHub(structuredClone(repeating).slice(0, 2), { totalOverride: 9 }).runner,
    });
    expect(incomplete.code).toBe(1);
    expect(incomplete.output).toContain('incomplete: SEEN=2 TOTAL=9');
    expect(
      run(['classes', '--pr', '7', '--repository', 'acme/widgets'], {
        runner: () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }),
      }).code,
    ).toBe(1);
    const runner = fakeGitHub([]).runner;
    expect(() => run(['classes'], { runner })).toThrow(UsageError);
    expect(() => run(['classes', '--pr', 'x', '--repository', 'a/b'], { runner })).toThrow(
      UsageError,
    );
    expect(() => run(['classes', '--pr', '7', '--repository', 'ab'], { runner })).toThrow(
      UsageError,
    );
    expect(() => run(['classes', '--pr', '7', '--repository', 'a/b', 'extra'], { runner })).toThrow(
      UsageError,
    );
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
