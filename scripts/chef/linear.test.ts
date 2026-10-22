import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf, throwingRejectionOf } from '../promise-outcome.test-support.ts';
import {
  blockIssue,
  createClient,
  LinearError,
  normalizeMarkdown,
  run,
  type FetchLike,
} from './linear.ts';
import { UsageError } from './process-runner.ts';

const SECRET = 'lin_api_test_secret_value';

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  updatedAt: string;
  stateId: string;
  teamId: string;
  labelIds: string[];
  projectId: string | null;
}

interface FakeComment {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
}

/** A tiny in-memory Linear. Switches inject the ways a write can silently not take. */
function fakeLinear() {
  const teams = [
    { id: 'team-cor', key: 'COR', parent: { id: 'team-eng' } },
    { id: 'team-eng', key: 'ENG', parent: null },
  ];
  const states = [
    { id: 's-todo', name: 'Todo', team: { id: 'team-eng' } },
    { id: 's-doing', name: 'In Progress', team: { id: 'team-eng' } },
    { id: 's-done', name: 'Done', team: { id: 'team-cor' } },
  ];
  const labels = [
    { id: 'l-feature', name: 'Feature', team: { id: 'team-eng' } },
    { id: 'l-bug', name: 'Bug', team: { id: 'team-other' } },
  ];
  const issues: FakeIssue[] = [
    {
      id: 'uuid-1',
      identifier: 'COR-1',
      title: 'First',
      description: 'Original body',
      updatedAt: '2026-10-22T10:00:00Z',
      stateId: 's-todo',
      teamId: 'team-cor',
      labelIds: [],
      projectId: 'proj-1',
    },
    {
      id: 'uuid-2',
      identifier: 'COR-2',
      title: 'Second',
      description: '',
      updatedAt: '2026-10-22T10:00:00Z',
      stateId: 's-todo',
      teamId: 'team-cor',
      labelIds: [],
      projectId: null,
    },
  ];
  const comments: FakeComment[] = [];
  const relations: { type: string; issueId: string; relatedIssueId: string }[] = [];
  const log: {
    operation: string;
    variables: Record<string, unknown>;
    authorization: string | null;
  }[] = [];
  const switches = {
    ignoreStateUpdate: false,
    mangleComment: false,
    dropRelation: false,
    ignoreDescription: false,
  };
  let counter = 100;

  const view = (issue: FakeIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
    state: states.find((state) => state.id === issue.stateId),
    team: teams.find((team) => team.id === issue.teamId),
    labels: { nodes: issue.labelIds.map((id) => ({ id })) },
    project: issue.projectId === null ? null : { id: issue.projectId },
  });
  const find = (id: unknown) => issues.find((issue) => issue.id === id || issue.identifier === id);
  const brief = (issue: FakeIssue) => ({
    identifier: issue.identifier,
    title: issue.title,
    state: states.find((state) => state.id === issue.stateId),
  });

  function handle(operation: string, variables: Record<string, any>): unknown {
    switch (operation) {
      case 'IssueRead': {
        const issue = find(variables.id);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueComments': {
        const issue = find(variables.id);
        if (issue === undefined) return { issue: null };
        // Newest first, the opposite of the order the code must impose.
        const nodes = comments.filter((comment) => comment.issueId === issue.id).toReversed();
        return {
          issue: {
            comments: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      case 'TeamStates': {
        const ids: string[] = variables.filter.team.id.in;
        return {
          workflowStates: {
            nodes: states.filter((state) => ids.includes(state.team.id)),
          },
        };
      }
      case 'IssueSetState': {
        const issue = find(variables.id)!;
        if (!switches.ignoreStateUpdate) issue.stateId = variables.stateId;
        return { issueUpdate: { success: true } };
      }
      case 'CommentPost': {
        const comment = {
          id: `c-${(counter += 1)}`,
          issueId: variables.issueId,
          body: switches.mangleComment ? `${variables.body}!!` : variables.body,
          createdAt: `2026-10-22T11:${String(comments.length).padStart(2, '0')}:00Z`,
        };
        comments.push(comment);
        return {
          commentCreate: { success: true, comment: { id: comment.id } },
        };
      }
      case 'CommentRead': {
        const comment = comments.find((candidate) => candidate.id === variables.id);
        if (comment === undefined) return { comment: null };
        return {
          comment: {
            id: comment.id,
            body: comment.body,
            issue: { identifier: find(comment.issueId)!.identifier },
          },
        };
      }
      case 'IssueSetDescription': {
        const issue = find(variables.id)!;
        // Linear escapes punctuation and rewrites bullets.
        if (!switches.ignoreDescription)
          issue.description = String(variables.description)
            .replace(/^\* /gm, '- ')
            .replace(/_/g, '\\_');
        return { issueUpdate: { success: true } };
      }
      case 'TeamByKey': {
        const team = teams.find((candidate) => candidate.key === variables.filter.key.eq);
        return { teams: { nodes: team === undefined ? [] : [team] } };
      }
      case 'DuplicateTitle': {
        const filter = variables.filter;
        const nodes = issues.filter(
          (issue) =>
            issue.title.toLowerCase() === filter.title.eqIgnoreCase.toLowerCase() &&
            (filter.project === undefined
              ? issue.teamId === filter.team.id.eq
              : issue.projectId === filter.project.id.eq),
        );
        return {
          issues: {
            nodes: nodes.map((issue) => ({
              identifier: issue.identifier,
              title: issue.title,
            })),
          },
        };
      }
      case 'LabelByName':
        return {
          issueLabels: {
            nodes: labels.filter(
              (label) =>
                label.name.toLowerCase() === variables.filter.name.eqIgnoreCase.toLowerCase(),
            ),
          },
        };
      case 'IssueMake': {
        const input = variables.input;
        const issue: FakeIssue = {
          id: `uuid-${(counter += 1)}`,
          identifier: `COR-${counter}`,
          title: input.title,
          description: input.description,
          updatedAt: '2026-10-22T12:00:00Z',
          stateId: input.stateId ?? 's-todo',
          teamId: input.teamId,
          labelIds: input.labelIds,
          projectId: input.projectId ?? null,
        };
        issues.push(issue);
        return {
          issueCreate: {
            success: true,
            issue: { id: issue.id, identifier: issue.identifier },
          },
        };
      }
      case 'IssueCreated': {
        const issue = find(variables.id);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueRelations': {
        const issue = find(variables.id);
        if (issue === undefined) return { issue: null };
        return {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            relations: {
              nodes: relations
                .filter((relation) => relation.issueId === issue.id)
                .map((relation) => ({
                  type: relation.type,
                  relatedIssue: brief(find(relation.relatedIssueId)!),
                })),
            },
            inverseRelations: {
              nodes: relations
                .filter((relation) => relation.relatedIssueId === issue.id)
                .map((relation) => ({
                  type: relation.type,
                  issue: brief(find(relation.issueId)!),
                })),
            },
          },
        };
      }
      case 'RelationMake': {
        if (!switches.dropRelation) relations.push(variables.input);
        return { issueRelationCreate: { success: true } };
      }
      default:
        throw new Error(`fake Linear: unhandled operation ${operation}`);
    }
  }

  const fetchLike: FetchLike = async (url, init) => {
    expect(url).toBe('https://api.linear.app/graphql');
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation) (\w+)/.exec(body.query)![1]!;
    const headers = init.headers as Record<string, string>;
    log.push({
      operation,
      variables: body.variables,
      authorization: headers.authorization ?? null,
    });
    try {
      return Response.json({ data: handle(operation, body.variables) });
    } catch (error) {
      if (String(error).includes('fake Linear')) throw error;
      return Response.json({ errors: [{ message: String(error) }] });
    }
  };
  return {
    fetch: fetchLike,
    issues,
    comments,
    relations,
    log,
    switches,
    states,
  };
}

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
  return { fetch: fake.fetch, environment: { LINEAR_API_KEY: SECRET } };
}

async function runCode(...args: Parameters<typeof run>): Promise<number> {
  const result = await run(...args);
  return result.code;
}

async function runOutput(...args: Parameters<typeof run>): Promise<string> {
  const result = await run(...args);
  return result.output;
}

describe('normalizeMarkdown', () => {
  test('ignores escaping, bullet style and whitespace', () => {
    expect(normalizeMarkdown('* a_b\n\n\n  c')).toBe(normalizeMarkdown('- a\\_b c'));
  });
});

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

describe('read', () => {
  test('reports state, updatedAt, the comment count and the first line of the last 3 comments in order', async () => {
    const fake = fakeLinear();
    for (const body of ['one\nmore', 'two', 'three', 'four'])
      await run(['comment', 'COR-1', '--file', file('c.md', body)], dependencies(fake));
    const result = await run(['read', 'COR-1'], dependencies(fake));
    expect(result.code).toBe(0);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('COR-1: state=Todo updatedAt=2026-10-22T10:00:00Z comments=4');
    expect(lines.slice(1).map((line) => line.trim().split(' ').slice(1).join(' '))).toEqual([
      'two',
      'three',
      'four',
    ]);
    const json = JSON.parse(await runOutput(['read', 'COR-1', '--json'], dependencies(fake)));
    expect(json.comments).toBe(4);
    expect(json.lastComments).toHaveLength(3);
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

  test('exits 1 when the stored comment differs', async () => {
    const fake = fakeLinear();
    fake.switches.mangleComment = true;
    expect(
      await runCode(['comment', 'COR-1', '--file', file('c.md', 'hello')], dependencies(fake)),
    ).toBe(1);
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
    expect(source.blocks).toEqual([{ identifier: 'COR-2', title: 'Second', state: 'Todo' }]);
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
