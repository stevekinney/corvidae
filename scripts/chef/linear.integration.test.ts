import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rejectionOf,
  throwingRejectionOf,
} from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  currentAuthority,
  recordMutationResult,
} from './execution-state.ts';
import {
  blockIssue,
  commentPageLimit,
  createClient,
  LinearError,
  missingCountLines,
  openBlockers,
  projectPageLimit,
  run,
  type FetchLike,
} from './linear.ts';
import { UsageError } from './process-runner.ts';

import { fakeLinear, SECRET } from './linear-test-fixture.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'linear-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const path = join(sandbox, name);
  writeFileSync(path, content);
  return path;
}

function dependencies(fake: ReturnType<typeof fakeLinear>) {
  return {
    fetch: fake.fetch,
    environment: { LINEAR_API_KEY: SECRET },
    executionStateDirectory: join(sandbox, 'execution-state'),
  };
}

async function runCode(...args: Parameters<typeof run>): Promise<number> {
  const result = await run(...args);
  return result.code;
}

async function runOutput(...args: Parameters<typeof run>): Promise<string> {
  const result = await run(...args);
  return result.output;
}

describe('the client', () => {
  test('requires the key from the environment and sends it only as a header', async () => {
    expect(
      await throwingRejectionOf(
        createClient({ environment: {}, resolveKey: () => undefined }).request('query X { a }'),
      ),
    ).toThrow(UsageError);
    const fake = fakeLinear();
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(fake.log.every((entry) => entry.authorization === SECRET)).toBe(true);
    expect(result.output).not.toContain(SECRET);
    expect(JSON.stringify(fake.log.map((entry) => entry.variables))).not.toContain(SECRET);
  });

  test('falls back to the credential resolver when the environment lacks the key', async () => {
    const fake = fakeLinear();
    const result = await run(['read', 'COR-1'], {
      fetch: fake.fetch,
      environment: {},
      resolveKey: () => SECRET,
    });
    expect(result.code).toBe(0);
    expect(fake.log.every((entry) => entry.authorization === SECRET)).toBe(true);
    expect(result.output).not.toContain(SECRET);
  });

  test('prefers the environment over the resolver', async () => {
    const fake = fakeLinear();
    await run(['read', 'COR-1'], {
      fetch: fake.fetch,
      environment: { LINEAR_API_KEY: SECRET },
      resolveKey: () => 'from-resolver',
    });
    expect(fake.log.every((entry) => entry.authorization === SECRET)).toBe(true);
  });

  test('an unavailable key is a usage error that names the variable and never a value', async () => {
    const error = await rejectionOf(
      run(['read', 'COR-1'], { environment: {}, resolveKey: () => undefined }),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('LINEAR_API_KEY');
  });

  test('turns a GraphQL error and a network failure into exit 1 without a stack', async () => {
    const failing: FetchLike = async () => Response.json({ errors: [{ message: 'boom' }] });
    const result = await run(['read', 'COR-1'], {
      fetch: failing,
      environment: { LINEAR_API_KEY: SECRET },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('boom');
    const down: FetchLike = async () => {
      throw new Error('offline');
    };
    expect(
      await throwingRejectionOf(
        createClient({
          fetch: down,
          environment: { LINEAR_API_KEY: SECRET },
        }).request('query X { a }'),
      ),
    ).toThrow(LinearError);
  });
});

describe('a credential never reaches an output', () => {
  // Bun's fetch rejects an invalid header with a message that quotes the whole value.
  const quoting: FetchLike = async () => {
    throw new TypeError(`Header 'Authorization' has invalid value: '${SECRET}'`);
  };

  test('a fetch error that quotes the key is reported by name only, in text and in JSON', async () => {
    for (const argv of [
      ['read', 'COR-1'],
      ['read', 'COR-1', '--json'],
    ]) {
      const result = await run(argv, {
        fetch: quoting,
        environment: { LINEAR_API_KEY: SECRET },
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('Linear request failed (TypeError)');
      expect(result.output).not.toContain(SECRET);
    }
    const error = await rejectionOf(
      createClient({ fetch: quoting, environment: { LINEAR_API_KEY: SECRET } }).request(
        'query X { a }',
      ),
    );
    expect(error).toBeInstanceOf(LinearError);
    expect(String(error)).not.toContain(SECRET);
  });

  test('a key that is not printable ASCII is never sent, and is not echoed', async () => {
    for (const bad of [
      `${SECRET}\n`,
      `${SECRET} ${SECRET}`,
      `\u201c${SECRET}\u201d`,
      `${SECRET}\u0000`,
    ]) {
      let sent = 0;
      const counting: FetchLike = async () => {
        sent += 1;
        return Response.json({ data: {} });
      };
      const error = await rejectionOf(
        run(['read', 'COR-1'], {
          fetch: counting,
          environment: { LINEAR_API_KEY: bad },
          resolveKey: () => undefined,
        }),
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain('not printable ASCII');
      expect((error as Error).message).not.toContain(SECRET);
      expect(sent).toBe(0);
    }
  });

  test('an unusable environment value falls back to the resolver, which supplies a usable key', async () => {
    const fake = fakeLinear();
    const result = await run(['read', 'COR-1'], {
      fetch: fake.fetch,
      environment: { LINEAR_API_KEY: `${SECRET}\n` },
      resolveKey: () => SECRET,
    });
    expect(result.code).toBe(0);
    expect(fake.log.every((entry) => entry.authorization === SECRET)).toBe(true);
    // A resolver that itself returns an unusable value is refused too.
    const error = await rejectionOf(
      run(['read', 'COR-1'], {
        fetch: fake.fetch,
        environment: {},
        resolveKey: () => `${SECRET} two`,
      }),
    );
    expect(error).toBeInstanceOf(UsageError);
  });
});

describe('read', () => {
  test('reports state, updatedAt, the comment count and the first line of the last 3 comments in order', async () => {
    const fake = fakeLinear();
    for (const body of ['one\nmore', 'two', 'three', 'four'])
      await run(['comment', 'COR-1', '--file', file('c.md', body)], dependencies(fake));
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(0);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('COR-1: state=Todo updatedAt=2026-10-22T10:00:00Z comments=4');
    expect(lines.slice(1, 4).map((line) => line.trim().split(' ').slice(1).join(' '))).toEqual([
      'two',
      'three',
      'four',
    ]);
    const json = JSON.parse(await runOutput(['read', 'COR-1', '--json'], dependencies(fake)));
    expect(json.comments).toBe(4);
    expect(json.lastComments).toHaveLength(3);
  });

  test('prints the full description after the summary lines and includes it in --json', async () => {
    const fake = fakeLinear();
    const body = '## Execution brief\n\nDo the thing.\n\n## Appended revision\n\nAlso this.';
    fake.issues[0]!.description = body;
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(0);
    const lines = result.output.split('\n');
    expect(lines[0]).toStartWith('COR-1: state=Todo');
    expect(result.output.endsWith(`\n${body}`)).toBe(true);
    const json = JSON.parse(await runOutput(['read', 'COR-1', '--json'], dependencies(fake)));
    expect(json.description).toBe(body);
  });

  test('prints no description block for an issue without one', async () => {
    const fake = fakeLinear();
    fake.issues[0]!.description = '';
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(result.output.split('\n')).toHaveLength(1);
    const json = JSON.parse(await runOutput(['read', 'COR-1', '--json'], dependencies(fake)));
    expect(json.description).toBe('');
  });

  test('exits 1 for an unknown issue', async () => {
    const result = await run(['read', 'COR-404'], dependencies(fakeLinear()));
    expect(result.code).toBe(1);
    expect(result.output).toContain('No issue COR-404');
  });
});

describe('state', () => {
  test("resolves the state by name (own team first, then the parent's), sets it and reads it back", async () => {
    const fake = fakeLinear();
    const result = await run(['state', 'COR-1', 'in progress'], dependencies(fake));
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.stateId).toBe('s-doing');
    expect(result.output).toContain('Todo -> In Progress');
    expect(await runCode(['state', 'COR-1', 'Done'], dependencies(fake))).toBe(0);
    expect(fake.issues[0]!.stateId).toBe('s-done');
  });

  test('exits 1 and lists the available states for an unknown name, writing nothing', async () => {
    const fake = fakeLinear();
    const result = await run(['state', 'COR-1', 'Shipped'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('Done, In Progress, Todo');
    expect(fake.log.some((entry) => entry.operation === 'IssueSetState')).toBe(false);
  });

  test('exits 1 when the read-back shows the write did not take', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreStateUpdate = true;
    const result = await run(['state', 'COR-1', 'Done'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('read-back mismatch');
  });
});

describe('describe', () => {
  test('replaces the description and reads it back as Linear normalizes it', async () => {
    const fake = fakeLinear();
    const result = await run(
      ['describe', 'COR-1', '--file', file('body.md', '* new_body\n')],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.description).toBe('- new\\_body\n');
  });

  test('exits 1 when the write did not take', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreDescription = true;
    const result = await run(
      ['describe', 'COR-1', '--file', file('body.md', 'New body')],
      dependencies(fake),
    );
    expect(result.code).toBe(1);
  });
});

describe('priority and labels', () => {
  test('priority sets the level by name and reads it back', async () => {
    const fake = fakeLinear();
    const result = await run(['priority', 'COR-1', 'High'], dependencies(fake));
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.priority).toBe(2);
    expect(result.output).toContain('priority high (read back)');
  });

  test('priority refuses an unknown level before any request', async () => {
    const fake = fakeLinear();
    expect(
      await throwingRejectionOf(run(['priority', 'COR-1', 'whenever'], dependencies(fake))),
    ).toThrow(UsageError);
    expect(fake.log).toHaveLength(0);
  });

  test('priority exits 1 when the read-back shows the write did not take', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreTriageUpdate = true;
    const result = await run(['priority', 'COR-1', 'low'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('read-back mismatch');
  });

  test("labels adds the team's, its parent's and workspace labels, keeping the ones held", async () => {
    const fake = fakeLinear();
    fake.issues[0]!.labelIds = ['l-existing'];
    const result = await run(
      ['labels', 'COR-1', '--add', 'feature', '--add', 'Chore'],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.labelIds).toEqual(['l-existing', 'l-feature', 'l-chore']);
  });

  test("labels refuses a label of another team, or a group's name, writing nothing", async () => {
    for (const name of ['Bug', 'Work Type']) {
      const fake = fakeLinear();
      const result = await run(['labels', 'COR-1', '--add', name], dependencies(fake));
      expect(result.code).toBe(1);
      expect(result.output).toContain(`No label "${name}"`);
      expect(fake.log.some((entry) => entry.operation === 'IssueAddLabels')).toBe(false);
    }
  });

  test('labels exits 1 when the read-back lacks a label', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreTriageUpdate = true;
    const result = await run(['labels', 'COR-1', '--add', 'Feature'], dependencies(fake));
    expect(result.code).toBe(1);
  });

  test('--add applies only to labels, and labels needs one', async () => {
    const fake = fakeLinear();
    expect(
      await throwingRejectionOf(run(['read', 'COR-1', '--add', 'Feature'], dependencies(fake))),
    ).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['labels', 'COR-1'], dependencies(fake)))).toThrow(
      UsageError,
    );
    expect(fake.log).toHaveLength(0);
  });
});

describe('comment', () => {
  test('posts and reads back by comment id, comparing after trimming', async () => {
    const fake = fakeLinear();
    const result = await run(
      ['comment', 'COR-1', '--file', file('c.md', '  hello\n\n')],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(fake.comments[0]!.body).toBe('  hello\n\n');
    expect(fake.log.some((entry) => entry.operation === 'CommentRead')).toBe(true);
  });

  test('accepts a comment Linear stored with its Markdown reformatted', async () => {
    const fake = fakeLinear();
    fake.switches.reformatComment = true;
    const result = await run(
      ['comment', 'COR-1', '--file', file('c.md', '* item_one\n* item_two\n')],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('posted (read back)');
    expect(fake.comments[0]!.body).toBe('- item\\_one\n- item\\_two\n');
  });

  test('exits 1 when the stored comment differs', async () => {
    const fake = fakeLinear();
    fake.switches.mangleComment = true;
    expect(
      await runCode(['comment', 'COR-1', '--file', file('c.md', 'hello')], dependencies(fake)),
    ).toBe(1);
  });
});

describe('comment --update', () => {
  const seeded = (userId = 'user-me') => {
    const fake = fakeLinear();
    fake.comments.push({
      id: 'c-old',
      issueId: 'uuid-1',
      body: 'Execution report: cor-1 attempt 1\n\nFirst draft.',
      createdAt: '2026-10-22T11:00:00Z',
      userId,
    });
    return fake;
  };

  test('replaces my own comment on the issue and reads it back, posting nothing new', async () => {
    const fake = seeded();
    const result = await run(
      ['comment', 'COR-1', '--update', 'c-old', '--file', file('c.md', 'Revised.')],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('comment c-old updated (read back)');
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]!.body).toBe('Revised.');
    expect(fake.log.some((entry) => entry.operation === 'CommentPost')).toBe(false);
  });

  test("refuses another user's comment and a comment on another issue, changing nothing", async () => {
    const theirs = seeded('user-other');
    const refused = await run(
      ['comment', 'COR-1', '--update', 'c-old', '--file', file('c.md', 'Revised.')],
      dependencies(theirs),
    );
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('was written by another user');
    expect(theirs.log.some((entry) => entry.operation === 'CommentUpdate')).toBe(false);

    const elsewhere = seeded();
    const wrongIssue = await run(
      ['comment', 'COR-2', '--update', 'c-old', '--file', file('c.md', 'Revised.')],
      dependencies(elsewhere),
    );
    expect(wrongIssue.code).toBe(1);
    expect(wrongIssue.output).toContain('belongs to COR-1');
    expect(elsewhere.comments[0]!.body).toContain('First draft.');
  });

  test('exits 1 when the updated comment reads back differently', async () => {
    const fake = seeded();
    fake.switches.mangleComment = true;
    expect(
      await runCode(
        ['comment', 'COR-1', '--update', 'c-old', '--file', file('c.md', 'Revised.')],
        dependencies(fake),
      ),
    ).toBe(1);
  });

  test('rejects --update without an id, or on another command, before any request', async () => {
    const fake = seeded();
    const deps = dependencies(fake);
    expect(
      await throwingRejectionOf(
        run(['comment', 'COR-1', '--update', '', '--file', file('c.md', 'x')], deps),
      ),
    ).toThrow(UsageError);
    expect(
      await throwingRejectionOf(
        run(['append', 'COR-1', '--update', 'c-old', '--file', file('c.md', 'x')], deps),
      ),
    ).toThrow(UsageError);
    expect(fake.log).toHaveLength(0);
  });
});

describe('append', () => {
  test("appends after a blank line and accepts Linear's Markdown normalization", async () => {
    const fake = fakeLinear();
    const result = await run(
      ['append', 'COR-1', '--file', file('a.md', '* item_one\n* item_two\n')],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.description.startsWith('Original body\n\n- item')).toBe(true);
  });

  test('fills an empty description without a leading blank line', async () => {
    const fake = fakeLinear();
    await run(['append', 'COR-2', '--file', file('a.md', 'text')], dependencies(fake));
    expect(fake.issues[1]!.description).toBe('text');
  });

  test('exits 1 when the appended text is absent on read-back', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreDescription = true;
    expect(
      await runCode(['append', 'COR-1', '--file', file('a.md', 'new text')], dependencies(fake)),
    ).toBe(1);
  });
});

describe('create', () => {
  const base = (extra: string[] = []) => [
    'create',
    '--team',
    'COR',
    '--title',
    'Fresh issue',
    '--file',
    file('d.md', 'Body text'),
    '--label',
    'feature',
    ...extra,
  ];

  test('creates with a name-resolved label (inherited from the parent team) and state, then reads it back', async () => {
    const fake = fakeLinear();
    const result = await run(base(['--state', 'In Progress']), dependencies(fake));
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^COR-\d+: created in COR/);
    const created = fake.issues.at(-1)!;
    expect(created.labelIds).toEqual(['l-feature']);
    expect(created.stateId).toBe('s-doing');
  });

  test('verifies a table and bullets against the normalized echo, but not a changed word', async () => {
    const body = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n';
    const fake = fakeLinear();
    fake.switches.normalizeCreated = true;
    const args = (text: string) => [
      'create',
      '--team',
      'COR',
      '--title',
      `T ${text.length}`,
      '--file',
      file('t.md', text),
      '--label',
      'feature',
    ];
    const ok = await run(args(body), dependencies(fake));
    expect(ok.code).toBe(0);
    expect(ok.output).toContain('(read back)');
    fake.switches.alterCreatedWord = true;
    const altered = await run(args(`${body}x`), dependencies(fake));
    expect(altered.code).toBe(1);
    expect(altered.output).toContain('read-back does not match');
  });

  test('refuses a duplicate title in the same project, ignoring case, and creates nothing', async () => {
    const fake = fakeLinear();
    const before = fake.issues.length;
    const result = await run(
      [
        'create',
        '--team',
        'COR',
        '--project',
        'proj-1',
        '--title',
        'FIRST',
        '--file',
        file('d.md', 'x'),
        '--label',
        'feature',
      ],
      dependencies(fake),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('COR-1 already has the title');
    expect(fake.issues).toHaveLength(before);
    expect(fake.log.some((entry) => entry.operation === 'IssueMake')).toBe(false);
  });

  test('scopes the duplicate check to the team when there is no project, and to the project when there is one', async () => {
    const fake = fakeLinear();
    expect(
      await runCode(
        [
          'create',
          '--team',
          'COR',
          '--title',
          'Second',
          '--file',
          file('d.md', 'x'),
          '--label',
          'feature',
        ],
        dependencies(fake),
      ),
    ).toBe(1);
    // COR-2 has no project, so "Second" does not collide inside proj-1.
    const inProject = await run(
      [
        'create',
        '--team',
        'COR',
        '--project',
        'proj-1',
        '--title',
        'Second',
        '--file',
        file('d.md', 'x'),
        '--label',
        'feature',
      ],
      dependencies(fake),
    );
    expect(inProject.code).toBe(0);
  });

  test('exits 1 for a label another team owns, an unknown state and an unknown team', async () => {
    const fake = fakeLinear();
    expect(
      await runCode(
        ['create', '--team', 'COR', '--title', 'T1', '--file', file('d.md', 'x'), '--label', 'bug'],
        dependencies(fake),
      ),
    ).toBe(1);
    expect(await runCode(base(['--state', 'Nope']), dependencies(fake))).toBe(1);
    expect(
      await runCode(
        [
          'create',
          '--team',
          'ZZZ',
          '--title',
          'T2',
          '--file',
          file('d.md', 'x'),
          '--label',
          'feature',
        ],
        dependencies(fake),
      ),
    ).toBe(1);
    expect(fake.issues).toHaveLength(2);
  });
});

describe('reads that could silently omit entries', () => {
  test('blockers fails loudly when a relation list has another page', async () => {
    const fake = fakeLinear();
    fake.switches.pagedRelations = true;
    const result = await run(['blockers', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('more than 100 relations');
    expect(result.output).toContain('refusing to report a partial list');
    const jsonResult = await run(['blockers', 'COR-1', '--json'], dependencies(fake));
    expect(JSON.parse(jsonResult.output).ok).toBe(false);
    // `block` reads the same lists, so it stops rather than add to a list it cannot see whole.
    const blocked = await run(['block', 'COR-1', '--by', 'COR-2'], dependencies(fake));
    expect(blocked.code).toBe(1);
    expect(fake.relations).toEqual([]);
  });

  test('read fails loudly instead of reporting a partial comment list', async () => {
    const fake = fakeLinear();
    fake.switches.endlessComments = true;
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('more than 10000 comments');
    expect(fake.log.filter((entry) => entry.operation === 'IssueComments')).toHaveLength(
      commentPageLimit,
    );
  });
});

describe('blockers and block', () => {
  test('block makes the --by issue block the target, reads it back, and blockers shows both directions', async () => {
    const fake = fakeLinear();
    const result = await run(['block', 'COR-2', '--by', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(0);
    expect(fake.relations).toEqual([
      { issueId: 'uuid-1', relatedIssueId: 'uuid-2', type: 'blocks' },
    ]);
    const target = await runOutput(['blockers', 'COR-2'], dependencies(fake));
    expect(target).toContain('COR-2 is blocked by 1:\n  COR-1 [Todo] First');
    expect(target).toContain('COR-2 blocks 0:');
    const source = JSON.parse(await runOutput(['blockers', 'COR-1', '--json'], dependencies(fake)));
    expect(source.blocks).toEqual([
      { identifier: 'COR-2', title: 'Second', state: 'Todo', stateType: 'unstarted' },
    ]);
  });

  test('openBlockers keeps every blocker that is not completed, a canceled one included', async () => {
    const fake = fakeLinear();
    fake.issues.push(
      {
        ...fake.issues[1]!,
        id: 'uuid-3',
        identifier: 'COR-3',
        title: 'Done one',
        stateId: 's-done',
      },
      {
        ...fake.issues[1]!,
        id: 'uuid-4',
        identifier: 'COR-4',
        title: 'Dropped',
        stateId: 's-canceled',
      },
    );
    for (const blocker of ['uuid-1', 'uuid-3', 'uuid-4'])
      fake.relations.push({ issueId: blocker, relatedIssueId: 'uuid-2', type: 'blocks' });
    const open = await openBlockers(createClient(dependencies(fake)), 'COR-2');
    expect(open.map((blocker) => `${blocker.identifier}:${blocker.stateType}`)).toEqual([
      'COR-1:unstarted',
      'COR-4:canceled',
    ]);
  });

  test('is idempotent: an existing relation is not created twice', async () => {
    const fake = fakeLinear();
    await run(['block', 'COR-2', '--by', 'COR-1'], dependencies(fake));
    const again = await run(['block', 'COR-2', '--by', 'COR-1'], dependencies(fake));
    expect(again.code).toBe(0);
    expect(again.output).toContain('already present');
    expect(fake.relations).toHaveLength(1);
  });

  test('exits 1 when the relation is absent on read-back', async () => {
    const fake = fakeLinear();
    fake.switches.dropRelation = true;
    expect(await runCode(['block', 'COR-2', '--by', 'COR-1'], dependencies(fake))).toBe(1);
  });

  test('rejects a self-block as a usage error', async () => {
    expect(
      await throwingRejectionOf(
        blockIssue(createClient(dependencies(fakeLinear())), 'COR-1', 'COR-1'),
      ),
    ).toThrow(UsageError);
  });
});

describe('usage', () => {
  test('rejects bad arguments before any request', async () => {
    const fake = fakeLinear();
    const deps = dependencies(fake);
    expect(await throwingRejectionOf(run([], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['nope'], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['read'], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['state', 'COR-1'], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['comment', 'COR-1'], deps))).toThrow(UsageError);
    expect(
      await throwingRejectionOf(
        run(['comment', 'COR-1', '--file', join(sandbox, 'missing.md')], deps),
      ),
    ).toThrow(UsageError);
    expect(
      await throwingRejectionOf(
        run(['comment', 'COR-1', '--file', file('empty.md', '  \n')], deps),
      ),
    ).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['create', '--team', 'COR'], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['block', 'COR-1'], deps))).toThrow(UsageError);
    expect(await throwingRejectionOf(run(['read', 'COR-1', '--bogus', 'x'], deps))).toThrow(
      UsageError,
    );
    expect(fake.log).toHaveLength(0);
  });
});

const countLines = [
  'Open: 10',
  'Ready: 1',
  'Done this run: 2',
  'Batches merged: 2',
  'Batches running: 0',
  'Blockers: COR-2267',
].join('\n');

describe('project-read', () => {
  test('prints name, status, latest update health and issue counts by state type, across pages', async () => {
    const fake = fakeLinear();
    fake.extraProjectIssueTypes.push('completed', 'started', 'backlog', 'canceled', 'triage');
    fake.projectUpdates.push({
      id: 'pu-1',
      projectId: 'proj-1',
      health: 'atRisk',
      body: 'x',
      createdAt: '2026-11-08T10:00:00Z',
    });
    const result = await run(['project-read', 'Alpha'], dependencies(fake));
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      'Alpha: status=Backlog health=atRisk issues=6\n  lease: none\n  completed=1 started=1 unstarted=1 backlog=1 canceled=1 other=1',
    );
    // Six issues at two per page: the count followed the cursor.
    expect(fake.log.filter((entry) => entry.operation === 'ProjectIssues')).toHaveLength(3);
    const json = JSON.parse(
      await runOutput(['project-read', 'Alpha', '--json'], dependencies(fake)),
    );
    expect(json).toMatchObject({
      ok: true,
      project: 'Alpha',
      status: 'Backlog',
      health: 'atRisk',
      counts: { completed: 1, started: 1, unstarted: 1, backlog: 1, canceled: 1, other: 1 },
    });
  });

  test('reports health none for a project without an update, and finds it by id and slug id', async () => {
    const fake = fakeLinear();
    expect(await runOutput(['project-read', 'proj-2'], dependencies(fake))).toContain(
      'Beta: status=In Progress health=none issues=0',
    );
    expect(await runOutput(['project-read', 'slug-one'], dependencies(fake))).toContain(
      'Alpha: status=Backlog',
    );
  });

  test('refuses an ambiguous name, naming the candidates, and an unknown one', async () => {
    const fake = fakeLinear();
    const ambiguous = await run(['project-read', 'beta'], dependencies(fake));
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.output).toContain('ambiguous');
    expect(ambiguous.output).toContain('slug-two');
    expect(ambiguous.output).toContain('slug-three');
    const unknown = await run(['project-read', 'Gamma'], dependencies(fake));
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('No project "Gamma"; available: "Alpha" (slug-one)');
    const similar = await run(['project-read', 'alph', '--json'], dependencies(fake));
    expect(similar.code).toBe(1);
    expect(JSON.parse(similar.output).error).toContain('similar: "Alpha"');
  });

  test('refuses to report a partial count when the issues never end', async () => {
    const fake = fakeLinear();
    const answer = fake.fetch;
    // Only the issue pages are endless; the project list is read whole.
    const result = await run(['project-read', 'proj-1'], {
      environment: { LINEAR_API_KEY: SECRET },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body as string) as { query: string };
        fake.switches.endlessProjectPages = body.query.includes('ProjectIssues');
        return answer(url, init);
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('refusing to report a partial list');
    expect(fake.log.filter((entry) => entry.operation === 'ProjectIssues')).toHaveLength(
      projectPageLimit,
    );
  });
});

describe('project-state', () => {
  test('resolves the status by name, sets it and reads it back', async () => {
    const fake = fakeLinear();
    const result = await run(['project-state', 'Alpha', 'in progress'], dependencies(fake));
    expect(result.code).toBe(0);
    expect(result.output).toBe('Alpha: Backlog -> In Progress (read back).');
    expect(fake.projects[0]!.statusId).toBe('ps-doing');
    const json = JSON.parse(
      await runOutput(['project-state', 'slug-one', 'Completed', '--json'], dependencies(fake)),
    );
    expect(json).toMatchObject({ ok: true, from: 'In Progress', to: 'Completed', verified: true });
  });

  test('refuses an unknown status, listing the available ones, and writes nothing', async () => {
    const fake = fakeLinear();
    const result = await run(['project-state', 'Alpha', 'Shipped'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('Backlog, Completed, In Progress');
    expect(fake.log.some((entry) => entry.operation === 'ProjectSetStatus')).toBe(false);
  });

  test('refuses an ambiguous project before any write', async () => {
    const fake = fakeLinear();
    const result = await run(['project-state', 'Beta', 'Completed'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(fake.log.some((entry) => entry.operation === 'ProjectSetStatus')).toBe(false);
  });

  test('exits 1 when the read-back shows the status did not change', async () => {
    const fake = fakeLinear();
    fake.switches.ignoreProjectStatus = true;
    const result = await run(['project-state', 'Alpha', 'Completed'], dependencies(fake));
    expect(result.code).toBe(1);
    expect(result.output).toContain('read-back mismatch');
    expect(result.output).toContain('the status is Backlog, expected Completed');
  });
});

describe('project-update', () => {
  test('creates the update with its health and body and reads it back, normalizing the body', async () => {
    const fake = fakeLinear();
    const body = `${countLines}\n\n* a bullet with snake_case`;
    const result = await run(
      ['project-update', 'Alpha', '--health', 'atRisk', '--file', file('update.md', body)],
      dependencies(fake),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('posted with health atRisk (read back)');
    expect(fake.projectUpdates).toHaveLength(1);
    expect(fake.projectUpdates[0]).toMatchObject({ projectId: 'proj-1', health: 'atRisk' });
    const json = JSON.parse(
      await runOutput(
        [
          'project-update',
          'slug-one',
          '--health',
          'onTrack',
          '--file',
          file('second.md', countLines),
          '--json',
        ],
        dependencies(fake),
      ),
    );
    expect(json).toMatchObject({ ok: true, health: 'onTrack', verified: true });
  });

  test('accepts count lines behind a list marker or bold, and names the ones a body lacks', () => {
    expect(missingCountLines(countLines)).toEqual([]);
    expect(
      missingCountLines(
        countLines
          .split('\n')
          .map((line, index) => (index % 2 === 0 ? `- **${line}` : `* ${line}`))
          .join('\n'),
      ),
    ).toEqual([]);
    expect(missingCountLines('Open: 1\nReady: 2')).toEqual([
      'Done this run:',
      'Batches merged:',
      'Batches running:',
      'Blockers:',
    ]);
    // A label in the middle of a line is not a count line.
    expect(missingCountLines(`Total Open: 1\n${countLines.replace('Open: 10\n', '')}`)).toEqual([
      'Open:',
    ]);
  });

  test('exits 1 when the body comes back changed', async () => {
    const fake = fakeLinear();
    fake.switches.mangleProjectUpdate = true;
    const result = await run(
      ['project-update', 'Alpha', '--health', 'onTrack', '--file', file('u.md', countLines)],
      dependencies(fake),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('read-back mismatch');
  });

  test('exits 1 when the health comes back different', async () => {
    const fake = fakeLinear();
    fake.switches.changeProjectHealth = true;
    const result = await run(
      ['project-update', 'Alpha', '--health', 'onTrack', '--file', file('u.md', countLines)],
      dependencies(fake),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('read-back mismatch');
  });

  test('exits 1 for an unknown or ambiguous project, creating nothing', async () => {
    const fake = fakeLinear();
    for (const project of ['Gamma', 'Beta']) {
      const result = await run(
        ['project-update', project, '--health', 'onTrack', '--file', file('u.md', countLines)],
        dependencies(fake),
      );
      expect(result.code).toBe(1);
    }
    expect(fake.projectUpdates).toHaveLength(0);
  });
});

describe('project command usage', () => {
  test('rejects bad arguments before any request', async () => {
    const fake = fakeLinear();
    const deps = dependencies(fake);
    const good = file('good.md', countLines);
    const lacking = file('lacking.md', 'Open: 1\nReady: 2\nDone this run: 0');
    const refused = async (...args: string[]) =>
      expect(await throwingRejectionOf(run(args, deps))).toThrow(UsageError);
    await refused('project-read');
    await refused('project-read', 'Alpha', 'extra');
    await refused('project-state', 'Alpha');
    await refused('project-update', 'Alpha', '--file', good);
    await refused('project-update', 'Alpha', '--health', 'onTrack');
    await refused('project-update', 'Alpha', '--health', 'green', '--file', good);
    await refused('project-update', 'Alpha', '--health', 'onTrack', '--file', lacking);
    await refused('project-update', 'Alpha', '--health', 'onTrack', '--file', file('e.md', ' '));
    await refused(
      'project-update',
      'Alpha',
      '--health',
      'onTrack',
      '--file',
      join(sandbox, 'no.md'),
    );
    await refused('project-read', 'Alpha', '--health', 'onTrack');
    await refused('read', 'COR-1', '--health', 'onTrack');
    expect(fake.log).toHaveLength(0);
  });

  test('names the missing count lines in the usage error', async () => {
    const lacking = file('lacking.md', 'Open: 1');
    const error = await rejectionOf(
      run(
        ['project-update', 'Alpha', '--health', 'onTrack', '--file', lacking],
        dependencies(fakeLinear()),
      ),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('Ready: Done this run: Batches merged:');
  });
});

/** The exit code of a pending `run` result. */
const codeOf = (pending: Promise<{ code: number }>) => pending.then((result) => result.code);

// Durable provider transitions inspect host state; execute before Bun's per-test clock.
sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));

const now = () => new Date('2026-10-22T12:00:00Z');
const withClock = (fake: ReturnType<typeof fakeLinear>, at = now) => ({
  ...dependencies(fake),
  now: at,
});
const claimLines = (fake: ReturnType<typeof fakeLinear>) =>
  fake.comments.filter((comment) => comment.body.startsWith('Claim:'));
const take = (fake: ReturnType<typeof fakeLinear>, runId: string, ...rest: string[]) =>
  run(['claim', 'COR-1', '--run', runId, '--branch', `branch-${runId}`, ...rest], withClock(fake));

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario1 = await (async () => {
  const fake = fakeLinear();
  const result = await take(fake, 'run-a', '--head', 'abc1234');
  expect(result.code).toBe(0);
  expect(result.output).toContain('claimed by run run-a on branch branch-run-a, head abc1234');
  expect(claimLines(fake)).toHaveLength(1);
  expect(claimLines(fake)[0]?.body.split('\n')[0]).toBe(
    'Claim: run run-a, branch branch-run-a, since 2026-10-22T12:00:00.000Z, checkpoint 2026-10-22T12:00:00.000Z, head abc1234, status held',
  );
  expect(fake.issues[0]?.stateId).toBe('s-doing');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario2 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'claim-authority');
  const first = run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory,
    ownerId: 'owner-a',
  });
  const second = run(['claim', 'COR-1', '--run', 'run-b', '--branch', 'branch-b'], {
    ...withClock(fake),
    executionStateDirectory,
    ownerId: 'owner-b',
  });
  const results = await Promise.all([first, second]);
  expect(results.filter((result) => result.code === 0)).toHaveLength(1);
  const state = JSON.parse(
    readFileSync(join(executionStateDirectory, 'execution-state.json'), 'utf8'),
  ) as {
    operations: Record<string, Record<string, unknown>>;
  };
  expect(Object.values(state.operations)).toContainEqual(
    expect.objectContaining({
      operationId: expect.stringMatching(/^issue:COR-1:1:claim:/),
      action: 'claim',
      outcome: 'observed',
      observed: expect.any(Object),
      nextAction: 'closeout',
      authority: expect.objectContaining({ generation: 1 }),
      intentFingerprint: expect.any(String),
    }),
  );

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario3 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'claim-stale-release');
  await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory,
    ownerId: 'owner-a',
  });
  const store = createExecutionStateStore({
    stateDirectory: executionStateDirectory,
    hostId: hostname(),
  });
  const first = await acquireDispatch(store, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);
  expect(await cancelDispatch(store, first.authority)).toBe(true);
  const second = await acquireDispatch(store, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!second.granted) throw new Error(second.reason);
  const release = await run(
    [
      'claim',
      'COR-1',
      '--release',
      '--run',
      'run-a',
      '--generation',
      String(first.authority.generation),
    ],
    { ...withClock(fake), executionStateDirectory, ownerId: 'owner-a' },
  );
  expect(release.code).toBe(1);
  expect(claimLines(fake)[0]?.body).toContain('status held');
  expect(second.authority.generation).toBe(first.authority.generation + 1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario4 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'claim-unknown');
  await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory,
    ownerId: 'owner-a',
  });
  const store = createExecutionStateStore({
    stateDirectory: executionStateDirectory,
    hostId: hostname(),
  });
  const authority = currentAuthority(store, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  const snapshot = JSON.parse(
    readFileSync(join(executionStateDirectory, 'execution-state.json'), 'utf8'),
  ) as {
    operations: Record<string, unknown>;
  };
  const operationId = Object.keys(snapshot.operations)[0]!;
  await recordMutationResult(store, authority, operationId, { outcome: 'unknown' });
  const result = await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory,
    ownerId: 'owner-a',
  });
  expect(result.code).toBe(0);
  expect(result.output).toContain('reconciled');
  expect(claimLines(fake)).toHaveLength(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario5 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'claim-intent-conflict');
  const input = { ...withClock(fake), executionStateDirectory, ownerId: 'owner-a' };
  await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], input);
  const store = createExecutionStateStore({
    stateDirectory: executionStateDirectory,
    hostId: hostname(),
  });
  const authority = currentAuthority(store, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  const snapshot = JSON.parse(
    readFileSync(join(executionStateDirectory, 'execution-state.json'), 'utf8'),
  ) as {
    operations: Record<string, unknown>;
  };
  const operationId = Object.keys(snapshot.operations)[0]!;
  await recordMutationResult(store, authority, operationId, { outcome: 'unknown' });

  const changed = await run(
    ['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a', '--head', 'def5678'],
    input,
  );
  expect(changed.code).toBe(1);
  expect(changed.output).toContain('retains unresolved operation');
  expect(claimLines(fake)).toHaveLength(1);

  const exact = await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], input);
  expect(exact.code).toBe(0);
  expect(exact.output).toContain('reconciled');
  expect(claimLines(fake)).toHaveLength(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario6 = await (async () => {
  const fake = fakeLinear();
  await take(fake, 'run-a');
  fake.issues[0]!.stateId = 's-todo';
  const result = await take(fake, 'run-b');
  expect(result.code).toBe(1);
  expect(result.output).toContain('held remotely by run-a');
  expect(claimLines(fake)).toHaveLength(1);
  expect(fake.issues[0]?.stateId).toBe('s-todo');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario7 = await (async () => {
  const fake = fakeLinear();
  const first = await take(fake, 'run-a', '--head', 'abc1234');
  const firstBody = claimLines(fake)[0]?.body;
  const later = () => new Date('2026-10-22T15:00:00Z');
  const result = await run(
    ['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-run-a', '--head', 'def5678'],
    withClock(fake, later),
  );
  expect(first.code).toBe(0);
  expect(result.code).toBe(0);
  expect(claimLines(fake)).toHaveLength(1);
  expect(claimLines(fake)[0]?.body).not.toBe(firstBody);
  expect(claimLines(fake)[0]?.body).toContain('head def5678');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario8 = await (async () => {
  const fake = fakeLinear();
  await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory: join(sandbox, 'claim-source'),
    ownerId: 'owner-a',
  });
  const before = claimLines(fake).length;
  const differentIntent = await run(
    ['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a', '--head', 'def5678'],
    {
      ...withClock(fake),
      executionStateDirectory: join(sandbox, 'claim-missing-intent'),
      ownerId: 'owner-a',
    },
  );
  const foreignOwner = await run(['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-a'], {
    ...withClock(fake),
    executionStateDirectory: join(sandbox, 'claim-missing-owner'),
    ownerId: 'owner-b',
  });
  expect(differentIntent.code).toBe(1);
  expect(foreignOwner.code).toBe(1);
  expect(claimLines(fake)).toHaveLength(before);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario9 = await (async () => {
  const fake = fakeLinear();
  const first = await take(fake, 'run-a', '--head', 'abc1234');
  const firstBody = claimLines(fake)[0]?.body;
  const checkpoint = await run(
    ['claim', 'COR-1', '--run', 'run-a', '--branch', 'branch-run-a'],
    withClock(fake, () => new Date('2026-10-22T15:00:00Z')),
  );
  expect(first.code).toBe(0);
  expect(checkpoint.code).toBe(0);
  expect(checkpoint.output).toContain('Authority generation 1');
  expect(claimLines(fake)[0]?.body).not.toBe(firstBody);
  expect(claimLines(fake)[0]?.body).toContain('checkpoint 2026-10-22T15:00:00.000Z');
  expect(claimLines(fake)[0]?.body).toContain('head abc1234');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario10 = await (async () => {
  const fake = fakeLinear();
  await take(fake, 'run-a');
  const justUnder = () => new Date('2026-10-23T11:59:59Z');
  const early = await run(
    ['claim', 'COR-1', '--run', 'run-b', '--branch', 'b'],
    withClock(fake, justUnder),
  );
  expect(early.code).toBe(1);
  const nextDay = () => new Date('2026-10-23T12:00:01Z');
  const late = await run(
    ['claim', 'COR-1', '--run', 'run-b', '--branch', 'b'],
    withClock(fake, nextDay),
  );
  expect(late.code).toBe(0);
  expect(claimLines(fake)).toHaveLength(2);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario11 = await (async () => {
  const fake = fakeLinear();
  await take(fake, 'run-a');
  const released = await run(
    ['claim', 'COR-1', '--release', '--run', 'run-a', '--generation', '1'],
    withClock(fake),
  );
  expect(released.code).toBe(0);
  expect(claimLines(fake)[0]?.body.split('\n')[0]).toContain('status released');
  expect(await codeOf(take(fake, 'run-b'))).toBe(0);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario12 = await (async () => {
  const fake = fakeLinear();
  const none = await run(
    ['claim', 'COR-1', '--release', '--run', 'run-a', '--generation', '1'],
    withClock(fake),
  );
  expect(none.code).toBe(1);
  expect(none.output).toContain('release lacks current authority');
  await take(fake, 'run-a');
  const other = await run(
    ['claim', 'COR-1', '--release', '--run', 'run-b', '--generation', '1'],
    withClock(fake),
  );
  expect(other.code).toBe(1);
  expect(other.output).toContain('release lacks current authority');
  expect(claimLines(fake)[0]?.body).toContain('status held');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario13 = await (async () => {
  const fake = fakeLinear();
  fake.switches.raceClaim = true;
  const result = await take(fake, 'run-a');
  expect(result.code).toBe(1);
  expect(result.output).toContain('held by run other-run');
  expect(fake.issues[0]?.stateId).toBe('s-todo');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario14 = await (async () => {
  const fake = fakeLinear();
  fake.comments.push({
    id: 'c-1',
    issueId: 'uuid-1',
    body: 'Claim: run run\\-a, branch cor\\_1\\-x, since 2026-10-22T11:00:00Z, checkpoint 2026-10-22T11:00:00Z, head none, status held',
    createdAt: '2026-10-22T11:00:00Z',
  });
  const result = await take(fake, 'run-b');
  expect(result.code).toBe(1);
  expect(result.output).toContain('held remotely by run-a');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario15 = await (async () => {
  const fake = fakeLinear();
  fake.switches.mangleComment = true;
  expect(await codeOf(take(fake, 'run-a'))).toBe(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const claimScenario16 = await (async () => {
  const fake = fakeLinear();
  fake.switches.ignoreStateUpdate = true;
  expect(await codeOf(take(fake, 'run-a'))).toBe(1);
  const clean = fakeLinear();
  const deps = withClock(clean);
  const refused = async (...args: string[]) =>
    expect(await throwingRejectionOf(run(args, deps))).toThrow(UsageError);
  await refused('claim', 'COR-1', '--branch', 'b');
  await refused('claim', 'COR-1', '--run', 'r');
  await refused('claim', 'COR-1', '--run', 'r', '--branch', 'a,b');
  await refused('claim', 'COR-1', '--run', 'bad run', '--branch', 'b');
  await refused('claim', 'COR-1', '--run', 'r', '--branch', 'b', '--head', 'xyz');
  await refused('claim', 'COR-1', '--release', '--run', 'r', '--branch', 'b');
  await refused('claim', '--run', 'r', '--branch', 'b');
  await refused('read', 'COR-1', '--run', 'r');
  await refused('read', 'COR-1', '--release');
  await refused('lease', 'Alpha', '--run', 'r', '--branch', 'b');
  expect(clean.log).toHaveLength(0);

  return true;
})();

describe('claim', () => {
  test('writes the claim line, moves the issue to In Progress and reads both back', () => {
    expect(claimScenario1).toBe(true);
  });

  test('the supported claim route grants one local coordinator and records its mutation intent', () => {
    expect(claimScenario2).toBe(true);
  });

  test('a stale durable claim release cannot release the newer generation marker', () => {
    expect(claimScenario3).toBe(true);
  });

  test('a durable claim with a lost response reconciles its exact marker without repeating the mutation', () => {
    expect(claimScenario4).toBe(true);
  });

  test('a changed claim intent cannot replay while the original response is unresolved', () => {
    expect(claimScenario5).toBe(true);
  });

  test('refuses another run while the claim is live, naming the holder, and changes nothing', () => {
    expect(claimScenario6).toBe(true);
  });

  test('an observed claim can checkpoint a new head with a new marker identity', () => {
    expect(claimScenario7).toBe(true);
  });

  test('a missing snapshot refuses same-run markers with a different intent or owner', () => {
    expect(claimScenario8).toBe(true);
  });

  test('a checkpoint without --head keeps the recorded head', () => {
    expect(claimScenario9).toBe(true);
  });

  test('a claim with no checkpoint for 24 hours is not live, and another run may take it', () => {
    expect(claimScenario10).toBe(true);
  });

  test('a released claim does not block another run', () => {
    expect(claimScenario11).toBe(true);
  });

  test('--release refuses a run that does not hold the claim, and when there is none', () => {
    expect(claimScenario12).toBe(true);
  });

  test('refuses when another run claimed in the window between the read and the write', () => {
    expect(claimScenario13).toBe(true);
  });

  test('reads a claim whose punctuation Linear escaped', () => {
    expect(claimScenario14).toBe(true);
  });

  test('exits 1 when the claim comment comes back changed', () => {
    expect(claimScenario15).toBe(true);
  });

  test('exits 1 when the state did not take, and 2 on bad usage before any request', () => {
    expect(claimScenario16).toBe(true);
  });
});

// Durable provider transitions inspect host state; execute before Bun's per-test clock.
sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));

const leaseWithClock = (fake: ReturnType<typeof fakeLinear>, iso = '2026-11-09T12:00:00Z') => ({
  ...dependencies(fake),
  now: () => new Date(iso),
});
const leases = (fake: ReturnType<typeof fakeLinear>, projectId = 'proj-1') =>
  fake.projectUpdates.filter(
    (update) => update.projectId === projectId && update.body.startsWith('Lease:'),
  );

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario1 = await (async () => {
  const fake = fakeLinear();
  const result = await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  expect(result.code).toBe(0);
  expect(leases(fake)).toHaveLength(1);
  expect(leases(fake)[0]?.body.split('\n')[0]).toBe(
    'Lease: run run-a, since 2026-11-09T12:00:00.000Z, renewed 2026-11-09T12:00:00.000Z, status held',
  );
  const read = await runOutput(['project-read', 'Alpha'], leaseWithClock(fake));
  expect(read).toContain(
    '  lease: held by run run-a since 2026-11-09T12:00:00.000Z, renewed 2026-11-09T12:00:00.000Z',
  );
  const json = JSON.parse(
    await runOutput(['project-read', 'Alpha', '--json'], leaseWithClock(fake)),
  );
  expect(json.lease).toMatchObject({ run: 'run-a', live: true });

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario2 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'lease-authority');
  const [first, second] = await Promise.all([
    run(['lease', 'Alpha', '--run', 'run-a'], {
      ...leaseWithClock(fake),
      executionStateDirectory,
      ownerId: 'owner-a',
    }),
    run(['lease', 'Alpha', '--run', 'run-b'], {
      ...leaseWithClock(fake),
      executionStateDirectory,
      ownerId: 'owner-b',
    }),
  ]);
  expect([first, second].filter((result) => result.code === 0)).toHaveLength(1);
  expect(leases(fake)).toHaveLength(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario3 = await (async () => {
  const fake = fakeLinear();
  await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  const refused = await run(['lease', 'Alpha', '--run', 'run-b'], leaseWithClock(fake));
  expect(refused.code).toBe(1);
  expect(refused.output).toContain('held remotely by run-a');
  expect(leases(fake)).toHaveLength(1);
  expect(await codeOf(run(['lease', 'proj-2', '--run', 'run-b'], leaseWithClock(fake)))).toBe(0);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario4 = await (async () => {
  const fake = fakeLinear();
  await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  const renewed = await run(
    ['lease', 'Alpha', '--run', 'run-a'],
    leaseWithClock(fake, '2026-11-09T20:00:00Z'),
  );
  expect(renewed.code).toBe(0);
  expect(leases(fake).at(-1)?.body.split('\n')[0]).toBe(
    'Lease: run run-a, since 2026-11-09T12:00:00.000Z, renewed 2026-11-09T20:00:00.000Z, status held',
  );
  const live = await run(
    ['lease', 'Alpha', '--run', 'run-b'],
    leaseWithClock(fake, '2026-11-10T07:59:59Z'),
  );
  expect(live.code).toBe(1);
  const expired = await run(
    ['lease', 'Alpha', '--run', 'run-b'],
    leaseWithClock(fake, '2026-11-10T08:00:01Z'),
  );
  expect(expired.code).toBe(0);
  expect(leases(fake).at(-1)?.body).toContain('run run-b');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario5 = await (async () => {
  const fake = fakeLinear();
  await run(['lease', 'Alpha', '--run', 'run-a'], {
    ...leaseWithClock(fake),
    executionStateDirectory: join(sandbox, 'lease-source'),
    ownerId: 'owner-a',
  });
  const before = leases(fake).length;
  const refused = await run(['lease', 'Alpha', '--run', 'run-a'], {
    ...leaseWithClock(fake),
    executionStateDirectory: join(sandbox, 'lease-missing'),
    ownerId: 'owner-b',
  });
  expect(refused.code).toBe(1);
  expect(leases(fake)).toHaveLength(before);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario6 = await (async () => {
  const fake = fakeLinear();
  const executionStateDirectory = join(sandbox, 'lease-marker-race');
  const input = { ...leaseWithClock(fake), executionStateDirectory, ownerId: 'owner-a' };
  const acquired = await run(['lease', 'Alpha', '--run', 'run-a'], input);
  expect(acquired.code).toBe(0);
  const before = leases(fake).length;
  fake.switches.raceLeaseIdentity = true;
  const result = await run(['lease', 'Alpha', '--run', 'run-a'], input);
  expect(result.code).toBe(1);
  expect(leases(fake)).toHaveLength(before);
  expect(leases(fake)[0]?.body).toContain('operation replaced-operation');

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario7 = await (async () => {
  const fake = fakeLinear();
  const none = await run(
    ['lease', 'Alpha', '--release', '--run', 'run-a', '--generation', '1'],
    leaseWithClock(fake),
  );
  expect(none.code).toBe(1);
  await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  const other = await run(
    ['lease', 'Alpha', '--release', '--run', 'run-b', '--generation', '1'],
    leaseWithClock(fake),
  );
  expect(other.code).toBe(1);
  expect(other.output).toContain('release lacks current authority');
  const released = await run(
    ['lease', 'Alpha', '--release', '--run', 'run-a', '--generation', '1'],
    leaseWithClock(fake),
  );
  expect(released.code).toBe(0);
  expect(leases(fake).at(-1)?.body.split('\n')[0]).toContain('status released');
  expect(await runOutput(['project-read', 'Alpha'], leaseWithClock(fake))).toContain(
    'lease: released by run run-a',
  );
  expect(await codeOf(run(['lease', 'Alpha', '--run', 'run-b'], leaseWithClock(fake)))).toBe(0);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario8 = await (async () => {
  const fake = fakeLinear();
  await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  fake.projectUpdates.push({
    id: 'pu-x',
    projectId: 'proj-1',
    health: 'onTrack',
    body: 'Open: 3\nReady: 1',
    createdAt: '2026-11-09T13:00:00Z',
  });
  const refused = await run(['lease', 'Alpha', '--run', 'run-b'], leaseWithClock(fake));
  expect(refused.code).toBe(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario9 = await (async () => {
  const fake = fakeLinear();
  expect(await codeOf(run(['lease', 'Gamma', '--run', 'run-a'], leaseWithClock(fake)))).toBe(1);
  fake.switches.mangleProjectUpdate = true;
  expect(await codeOf(run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake)))).toBe(1);

  return true;
})();

sandbox = mkdtempSync(join(tmpdir(), 'linear-durable-'));
const leaseScenario10 = await (async () => {
  const fake = fakeLinear();
  fake.projectUpdates.push({
    id: 'pu-0',
    projectId: 'proj-1',
    health: 'atRisk',
    body: 'Open: 1',
    createdAt: '2026-11-08T10:00:00Z',
  });
  await run(['lease', 'Alpha', '--run', 'run-a'], leaseWithClock(fake));
  expect(leases(fake)[0]?.health).toBe('atRisk');
  return true;
})();

describe('lease', () => {
  test('records the lease as a project update whose first line is the marker, and project-read shows it', () => {
    expect(leaseScenario1).toBe(true);
  });

  test('the supported lease route fences a competing local coordinator', () => {
    expect(leaseScenario2).toBe(true);
  });

  test('refuses another run while the lease is live, and leases another project freely', () => {
    expect(leaseScenario3).toBe(true);
  });

  test('the same run renews, keeping since; a lease unrenewed for 12 hours expires', () => {
    expect(leaseScenario4).toBe(true);
  });

  test('a missing snapshot refuses a same-run lease marker owned by another coordinator', () => {
    expect(leaseScenario5).toBe(true);
  });

  test('refuses a changed same-owner lease marker after admission without writing an update', () => {
    expect(leaseScenario6).toBe(true);
  });

  test('--release ends the lease; it refuses a run that does not hold it', () => {
    expect(leaseScenario7).toBe(true);
  });

  test("carries the latest status update's health, so the project status does not change", () => {
    expect(leaseScenario10).toBe(true);
  });

  test('finds the lease among later status updates, whatever order the API lists them', () => {
    expect(leaseScenario8).toBe(true);
  });

  test('exits 1 for an unknown project and when the update comes back changed', () => {
    expect(leaseScenario9).toBe(true);
  });
});
