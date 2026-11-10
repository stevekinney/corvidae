import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rejectionOf,
  throwingRejectionOf,
} from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  blockIssue,
  commentPageLimit,
  createClient,
  LinearError,
  missingCountLines,
  normalizeMarkdown,
  openBlockers,
  projectPageLimit,
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
  /** The author; the fake's API key belongs to `user-me`. */
  userId?: string;
}

/** A tiny in-memory Linear. Switches inject the ways a write can silently not take. */
function fakeLinear() {
  const teams = [
    { id: 'team-cor', key: 'COR', parent: { id: 'team-eng' } },
    { id: 'team-eng', key: 'ENG', parent: null },
  ];
  const states = [
    { id: 's-todo', name: 'Todo', type: 'unstarted', team: { id: 'team-eng' } },
    { id: 's-doing', name: 'In Progress', type: 'started', team: { id: 'team-eng' } },
    { id: 's-done', name: 'Done', type: 'completed', team: { id: 'team-cor' } },
    { id: 's-canceled', name: 'Canceled', type: 'canceled', team: { id: 'team-eng' } },
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
  const projectStatuses = [
    { id: 'ps-backlog', name: 'Backlog' },
    { id: 'ps-doing', name: 'In Progress' },
    { id: 'ps-done', name: 'Completed' },
  ];
  const projects = [
    {
      id: 'proj-1',
      slugId: 'slug-one',
      name: 'Alpha',
      statusId: 'ps-backlog',
      updateIds: [] as string[],
    },
    {
      id: 'proj-2',
      slugId: 'slug-two',
      name: 'Beta',
      statusId: 'ps-doing',
      updateIds: [] as string[],
    },
    {
      id: 'proj-3',
      slugId: 'slug-three',
      name: 'Beta',
      statusId: 'ps-doing',
      updateIds: [] as string[],
    },
  ];
  const projectUpdates: {
    id: string;
    projectId: string;
    health: string;
    body: string;
    createdAt: string;
  }[] = [];
  /** State types of the issues in `proj-1`, in addition to COR-1 (unstarted). */
  const extraProjectIssueTypes: string[] = [];
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
    /** Linear reformats a comment the way it reformats a description. */
    reformatComment: false,
    /** Linear echoes a created description with `--` table rules and `*` bullets. */
    normalizeCreated: false,
    /** Linear echoes a created description with one word changed. */
    alterCreatedWord: false,
    /** More comments than the pages the reader will walk. */
    endlessComments: false,
    /** More relations than one page holds, in either direction. */
    pagedRelations: false,
    /** `projectUpdate` answers success without changing the status. */
    ignoreProjectStatus: false,
    /** A created project update comes back with a changed body. */
    mangleProjectUpdate: false,
    /** A created project update comes back with another health. */
    changeProjectHealth: false,
    /** More issues, projects or statuses than the pages the reader will walk. */
    endlessProjectPages: false,
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

  const pageInfo = (hasNextPage = switches.endlessProjectPages, endCursor = 'more') => ({
    hasNextPage,
    endCursor: hasNextPage ? endCursor : null,
  });

  function handle(operation: string, variables: Record<string, any>): unknown {
    switch (operation) {
      case 'IssueRead': {
        const issue = find(variables['id']);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueComments': {
        const issue = find(variables['id']);
        if (issue === undefined) return { issue: null };
        // Newest first, the opposite of the order the code must impose.
        const nodes = comments.filter((comment) => comment.issueId === issue.id).toReversed();
        return {
          issue: {
            comments: {
              nodes,
              pageInfo: {
                hasNextPage: switches.endlessComments,
                endCursor: switches.endlessComments ? 'more' : null,
              },
            },
          },
        };
      }
      case 'TeamStates': {
        const ids: string[] = variables['filter'].team.id.in;
        return {
          workflowStates: {
            nodes: states.filter((state) => ids.includes(state.team.id)),
          },
        };
      }
      case 'IssueSetState': {
        const issue = find(variables['id'])!;
        if (!switches.ignoreStateUpdate) issue.stateId = variables['stateId'];
        return { issueUpdate: { success: true } };
      }
      case 'CommentPost': {
        const comment = {
          id: `c-${(counter += 1)}`,
          issueId: variables['issueId'],
          body: switches.mangleComment
            ? `${variables['body']}!!`
            : switches.reformatComment
              ? String(variables['body']).replace(/^\* /gm, '- ').replace(/_/g, '\\_')
              : variables['body'],
          createdAt: `2026-10-22T11:${String(comments.length).padStart(2, '0')}:00Z`,
        };
        comments.push(comment);
        return {
          commentCreate: { success: true, comment: { id: comment.id } },
        };
      }
      case 'CommentRead': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        if (comment === undefined) return { comment: null };
        return {
          comment: {
            id: comment.id,
            body: comment.body,
            issue: { identifier: find(comment.issueId)!.identifier },
          },
        };
      }
      case 'CommentOwner': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        return {
          viewer: { id: 'user-me' },
          comment:
            comment === undefined
              ? null
              : {
                  id: comment.id,
                  user: { id: comment.userId ?? 'user-me' },
                  issue: { identifier: find(comment.issueId)!.identifier },
                },
        };
      }
      case 'CommentUpdate': {
        const comment = comments.find((candidate) => candidate.id === variables['id'])!;
        comment.body = switches.mangleComment ? `${variables['body']}!!` : variables['body'];
        return { commentUpdate: { success: true } };
      }
      case 'IssueSetDescription': {
        const issue = find(variables['id'])!;
        // Linear escapes punctuation and rewrites bullets.
        if (!switches.ignoreDescription)
          issue.description = String(variables['description'])
            .replace(/^\* /gm, '- ')
            .replace(/_/g, '\\_');
        return { issueUpdate: { success: true } };
      }
      case 'TeamByKey': {
        const team = teams.find((candidate) => candidate.key === variables['filter'].key.eq);
        return { teams: { nodes: team === undefined ? [] : [team] } };
      }
      case 'DuplicateTitle': {
        const filter = variables['filter'];
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
                label.name.toLowerCase() === variables['filter'].name.eqIgnoreCase.toLowerCase(),
            ),
          },
        };
      case 'IssueMake': {
        const input = variables['input'];
        const issue: FakeIssue = {
          id: `uuid-${(counter += 1)}`,
          identifier: `COR-${counter}`,
          title: input.title,
          description: switches.normalizeCreated
            ? String(input.description)
                .replace(/-{3,}/g, '--')
                .replace(/^- /gm, '* ')
                .replace(switches.alterCreatedWord ? 'one' : '\0', 'uno')
            : input.description,
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
        const issue = find(variables['id']);
        return { issue: issue === undefined ? null : view(issue) };
      }
      case 'IssueRelations': {
        const issue = find(variables['id']);
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
              pageInfo: { hasNextPage: switches.pagedRelations },
            },
            inverseRelations: {
              nodes: relations
                .filter((relation) => relation.relatedIssueId === issue.id)
                .map((relation) => ({
                  type: relation.type,
                  issue: brief(find(relation.issueId)!),
                })),
              pageInfo: { hasNextPage: false },
            },
          },
        };
      }
      case 'RelationMake': {
        if (!switches.dropRelation) relations.push(variables['input']);
        return { issueRelationCreate: { success: true } };
      }
      case 'ProjectList':
        return {
          projects: {
            nodes: projects.map(({ id, name, slugId }) => ({ id, name, slugId })),
            pageInfo: pageInfo(),
          },
        };
      case 'ProjectRead': {
        const project = projects.find((candidate) => candidate.id === variables['id']);
        if (project === undefined) return { project: null };
        const latest = projectUpdates.filter((update) => update.projectId === project.id).at(-1);
        return {
          project: {
            id: project.id,
            name: project.name,
            slugId: project.slugId,
            status: projectStatuses.find((status) => status.id === project.statusId) ?? null,
            lastUpdate: latest === undefined ? null : { id: latest.id, health: latest.health },
          },
        };
      }
      case 'ProjectIssues': {
        const project = projects.find((candidate) => candidate.id === variables['id']);
        if (project === undefined) return { project: null };
        const nodes = [
          ...issues
            .filter((issue) => issue.projectId === project.id)
            .map((issue) => ({
              state: { type: states.find((s) => s.id === issue.stateId)!.type },
            })),
          ...(project.id === 'proj-1'
            ? extraProjectIssueTypes.map((type) => ({ state: { type } }))
            : []),
        ];
        // Two issues per page, so a count has to follow the cursor.
        const start = variables['after'] === null ? 0 : Number(variables['after']);
        const end = start + 2;
        return {
          project: {
            issues: {
              nodes: nodes.slice(start, end),
              pageInfo: pageInfo(end < nodes.length || switches.endlessProjectPages, String(end)),
            },
          },
        };
      }
      case 'ProjectStatuses':
        return { projectStatuses: { nodes: projectStatuses, pageInfo: pageInfo() } };
      case 'ProjectSetStatus': {
        const project = projects.find((candidate) => candidate.id === variables['id'])!;
        if (!switches.ignoreProjectStatus) project.statusId = variables['statusId'];
        return { projectUpdate: { success: true } };
      }
      case 'ProjectUpdateMake': {
        const input = variables['input'];
        const update = {
          id: `pu-${(counter += 1)}`,
          projectId: input.projectId,
          health: switches.changeProjectHealth ? 'offTrack' : input.health,
          body: switches.mangleProjectUpdate
            ? `${input.body}!!`
            : String(input.body).replace(/^\* /gm, '- ').replace(/_/g, '\\_'),
          createdAt: '2026-11-09T10:00:00Z',
        };
        projectUpdates.push(update);
        return { projectUpdateCreate: { success: true, projectUpdate: { id: update.id } } };
      }
      case 'ProjectUpdateRead': {
        const update = projectUpdates.find((candidate) => candidate.id === variables['id']);
        return {
          projectUpdate:
            update === undefined
              ? null
              : {
                  id: update.id,
                  body: update.body,
                  health: update.health,
                  project: { id: update.projectId },
                },
        };
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
      authorization: headers['authorization'] ?? null,
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
    projects,
    projectUpdates,
    extraProjectIssueTypes,
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

describe('normalizeMarkdown tables', () => {
  test("treats Linear's shortened table rules and starred bullets as equal", () => {
    expect(normalizeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two')).toBe(
      normalizeMarkdown('| a | b |\n| -- | -- |\n| 1 | 2 |\n\n* one\n* two  \n'),
    );
  });

  test('keeps a horizontal rule significant, so a read-back that lost it differs', () => {
    expect(normalizeMarkdown('before\n\n---\n\nafter')).not.toBe(
      normalizeMarkdown('before\n\nafter'),
    );
    expect(normalizeMarkdown('before\n\n---\n\nafter')).toBe(
      normalizeMarkdown('before\n\n---\n\nafter'),
    );
  });

  test('leaves pipe spacing alone outside table rows', () => {
    expect(normalizeMarkdown('const label = "A | B";')).not.toBe(
      normalizeMarkdown('const label = "A|B";'),
    );
  });

  test('still tells a changed word apart', () => {
    expect(normalizeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).not.toBe(
      normalizeMarkdown('| a | b |\n| -- | -- |\n| 1 | 3 |'),
    );
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
      'Alpha: status=Backlog health=atRisk issues=6\n  completed=1 started=1 unstarted=1 backlog=1 canceled=1 other=1',
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
