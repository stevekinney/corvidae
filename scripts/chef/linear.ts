#!/usr/bin/env bun
// Chef Linear plumbing: the tracker reads and writes a chef run makes by hand, each as one call with
// a compact result. Every write is followed by a read, and a read that disagrees with the write is
// exit 1, so a green result means the tracker holds what was asked for. States, labels and teams are
// resolved by name from the API, never from hard-coded identifiers.
//
// Usage (the key is LINEAR_API_KEY: the environment first, then the macOS Keychain and `.env`
// files through credentials.ts; it is never printed or written):
//   bun scripts/chef/linear.ts read <ID> [--json]
//   bun scripts/chef/linear.ts state <ID> <State Name> [--json]
//   bun scripts/chef/linear.ts comment <ID> --file <md> [--json]
//   bun scripts/chef/linear.ts append <ID> --file <md> [--json]
//   bun scripts/chef/linear.ts create --team <KEY> [--project <id>] --title <t> --file <md> --label <name>
//                                [--state <name>] [--json]
//   bun scripts/chef/linear.ts blockers <ID> [--json]
//   bun scripts/chef/linear.ts block <ID> --by <ID> [--json]
//
// `create` refuses (exit 1) when an issue with the same title already exists in the project, or in
// the team when no project is named. `block <ID> --by <OTHER>` makes OTHER block ID.
//
// Exit codes: 0 success and read back, 1 refused, not found, API failure or read-back mismatch,
// 2 invalid CLI usage (including an unavailable LINEAR_API_KEY).

import { existsSync, readFileSync } from 'node:fs';
import { resolveCredential } from './credentials.ts';
import { parseOptions, UsageError } from './process-runner.ts';

/** The API rejected a request or answered with something unusable. */
export class LinearError extends Error {}

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearDependencies {
  fetch?: FetchLike;
  environment?: Record<string, string | undefined>;
  /** Finds the key when the environment lacks it; defaults to `credentials.ts`'s lookup. */
  resolveKey?: () => string | undefined;
}

export interface LinearClient {
  request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

/** A client over the injected `fetch`; the key goes only into the Authorization header. */
export function createClient(dependencies: LinearDependencies = {}): LinearClient {
  const send: FetchLike = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const environment = dependencies.environment ?? process.env;
  const resolveKey = dependencies.resolveKey ?? (() => resolveCredential('LINEAR_API_KEY').value);
  return {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      const key = environment.LINEAR_API_KEY || resolveKey();
      if (key === undefined || key === '')
        throw new UsageError(
          'LINEAR_API_KEY is unavailable: it is not in the environment, the macOS Keychain (service linear-api) or a .env file; see credentials.ts.',
        );
      let response: Response;
      try {
        response = await send(LINEAR_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: key },
          body: JSON.stringify({ query: document, variables }),
        });
      } catch (error) {
        throw new LinearError(`Linear request failed: ${String(error)}`);
      }
      let payload: { data?: T; errors?: { message?: string }[] };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new LinearError(
          `Linear answered HTTP ${response.status} with a body that is not JSON.`,
        );
      }
      if (payload.errors !== undefined && payload.errors.length > 0)
        throw new LinearError(
          `Linear rejected the request: ${payload.errors.map((entry) => entry.message ?? 'unknown error').join('; ')}`,
        );
      if (!response.ok || payload.data === undefined)
        throw new LinearError(`Linear answered HTTP ${response.status} without data.`);
      return payload.data;
    },
  };
}

/** Linear rewrites Markdown (escapes, list markers, spacing), so writes are compared in this form. */
export function normalizeMarkdown(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/^(\s*)[*+] /gm, '$1- ')
    .replace(/\\(?=[^A-Za-z0-9\s])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLine(text: string, limit = 120): string {
  const line = (text.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { id: string; name: string };
  team: { id: string; key: string; parent: { id: string } | null };
}

const issueFields = `id identifier title description updatedAt state { id name } team { id key parent { id } }`;

async function fetchIssue(client: LinearClient, identifier: string): Promise<IssueSummary> {
  let data: { issue: IssueSummary | null };
  try {
    data = await client.request(
      `query IssueRead($id: String!) { issue(id: $id) { ${issueFields} } }`,
      {
        id: identifier,
      },
    );
  } catch (error) {
    if (error instanceof LinearError && /not found|entity/i.test(error.message))
      throw new LinearError(`No issue ${identifier}.`);
    throw error;
  }
  if (data.issue === null || data.issue === undefined)
    throw new LinearError(`No issue ${identifier}.`);
  return data.issue;
}

export interface CommentSummary {
  id: string;
  body: string;
  createdAt: string;
}

async function fetchComments(client: LinearClient, identifier: string): Promise<CommentSummary[]> {
  const comments: CommentSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const data: {
      issue: {
        comments: {
          nodes: CommentSummary[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await client.request(
      `query IssueComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { id body createdAt } pageInfo { hasNextPage endCursor } } } }`,
      { id: identifier, after },
    );
    if (data.issue === null) throw new LinearError(`No issue ${identifier}.`);
    comments.push(...data.issue.comments.nodes);
    if (!data.issue.comments.pageInfo.hasNextPage) break;
    after = data.issue.comments.pageInfo.endCursor;
  }
  // The API's default order is not guaranteed, so "the last three" is decided here.
  return comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface Outcome {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
}

export async function readIssue(client: LinearClient, identifier: string): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const comments = await fetchComments(client, identifier);
  const last = comments.slice(-3).map((comment) => ({
    id: comment.id,
    createdAt: comment.createdAt,
    firstLine: firstLine(comment.body),
  }));
  return {
    ok: true,
    summary: [
      `${issue.identifier}: state=${issue.state.name} updatedAt=${issue.updatedAt} comments=${comments.length}`,
      ...last.map((comment) => `  ${comment.createdAt} ${comment.firstLine}`),
    ].join('\n'),
    data: {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state.name,
      updatedAt: issue.updatedAt,
      comments: comments.length,
      lastComments: last,
    },
  };
}

interface WorkflowState {
  id: string;
  name: string;
  team: { id: string };
}

/** The state named `name` for a team, preferring its own states over its parent team's. */
async function resolveState(
  client: LinearClient,
  team: { id: string; parent: { id: string } | null },
  name: string,
): Promise<{ state?: WorkflowState; available: string[] }> {
  const ids = team.parent === null ? [team.id] : [team.id, team.parent.id];
  const data = await client.request<{
    workflowStates: { nodes: WorkflowState[] };
  }>(
    `query TeamStates($filter: WorkflowStateFilter) { workflowStates(first: 250, filter: $filter) { nodes { id name team { id } } } }`,
    { filter: { team: { id: { in: ids } } } },
  );
  const wanted = name.trim().toLowerCase();
  const matches = data.workflowStates.nodes.filter(
    (state) => state.name.trim().toLowerCase() === wanted,
  );
  const own = matches.find((state) => state.team.id === team.id);
  return {
    state: own ?? matches[0],
    available: [...new Set(data.workflowStates.nodes.map((state) => state.name))].toSorted(),
  };
}

export async function setState(
  client: LinearClient,
  identifier: string,
  stateName: string,
): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const { state, available } = await resolveState(client, issue.team, stateName);
  if (state === undefined)
    return {
      ok: false,
      summary: `${issue.team.key} has no state "${stateName}"; it has: ${available.join(', ')}.`,
      data: { identifier, requested: stateName, updated: false, available },
    };
  const result = await client.request<{ issueUpdate: { success: boolean } }>(
    `mutation IssueSetState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
    { id: issue.id, stateId: state.id },
  );
  const after = await fetchIssue(client, identifier);
  const verified = result.issueUpdate.success && after.state.id === state.id;
  return {
    ok: verified,
    summary: verified
      ? `${identifier}: ${issue.state.name} -> ${after.state.name} (read back).`
      : `${identifier}: read-back mismatch; the state is ${after.state.name}, expected ${state.name}.`,
    data: {
      identifier,
      from: issue.state.name,
      to: after.state.name,
      requested: state.name,
      verified,
    },
  };
}

export async function postComment(
  client: LinearClient,
  identifier: string,
  body: string,
): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const created = await client.request<{
    commentCreate: { success: boolean; comment: { id: string } | null };
  }>(
    `mutation CommentPost($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`,
    { issueId: issue.id, body },
  );
  const id = created.commentCreate.comment?.id;
  if (!created.commentCreate.success || id === undefined)
    return {
      ok: false,
      summary: `${identifier}: the comment was not created.`,
      data: { identifier, verified: false },
    };
  const back = await client.request<{
    comment: {
      id: string;
      body: string;
      issue: { identifier: string } | null;
    } | null;
  }>(`query CommentRead($id: String!) { comment(id: $id) { id body issue { identifier } } }`, {
    id,
  });
  const verified =
    back.comment !== null &&
    back.comment.body.trim() === body.trim() &&
    back.comment.issue?.identifier === issue.identifier;
  return {
    ok: verified,
    summary: verified
      ? `${identifier}: comment ${id} posted (read back).`
      : `${identifier}: comment ${id} read-back mismatch.`,
    data: { identifier, commentId: id, verified },
  };
}

export async function appendDescription(
  client: LinearClient,
  identifier: string,
  addition: string,
): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const current = (issue.description ?? '').replace(/\s+$/, '');
  const text = addition.trim();
  const next = current === '' ? text : `${current}\n\n${text}`;
  const result = await client.request<{ issueUpdate: { success: boolean } }>(
    `mutation IssueSetDescription($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }`,
    { id: issue.id, description: next },
  );
  const after = await fetchIssue(client, identifier);
  const verified =
    result.issueUpdate.success &&
    normalizeMarkdown(after.description ?? '').includes(normalizeMarkdown(text));
  return {
    ok: verified,
    summary: verified
      ? `${identifier}: appended ${text.length} characters (read back).`
      : `${identifier}: the appended text is not in the description on read-back.`,
    data: { identifier, appendedCharacters: text.length, verified },
  };
}

export interface CreateOptions {
  team: string;
  project?: string;
  title: string;
  description: string;
  label: string;
  state?: string;
}

export async function createIssue(client: LinearClient, options: CreateOptions): Promise<Outcome> {
  const teams = await client.request<{
    teams: {
      nodes: { id: string; key: string; parent: { id: string } | null }[];
    };
  }>(
    `query TeamByKey($filter: TeamFilter) { teams(first: 5, filter: $filter) { nodes { id key parent { id } } } }`,
    { filter: { key: { eq: options.team } } },
  );
  const team = teams.teams.nodes[0];
  if (team === undefined)
    return {
      ok: false,
      summary: `No team ${options.team}.`,
      data: { created: false, reason: 'team' },
    };
  const scope =
    options.project === undefined
      ? { team: { id: { eq: team.id } } }
      : { project: { id: { eq: options.project } } };
  const existing = await client.request<{
    issues: { nodes: { identifier: string; title: string }[] };
  }>(
    `query DuplicateTitle($filter: IssueFilter) { issues(first: 5, filter: $filter) { nodes { identifier title } } }`,
    { filter: { ...scope, title: { eqIgnoreCase: options.title } } },
  );
  const duplicate = existing.issues.nodes[0];
  if (duplicate !== undefined)
    return {
      ok: false,
      summary: `Refused: ${duplicate.identifier} already has the title "${duplicate.title}" in this ${options.project === undefined ? 'team' : 'project'}.`,
      data: {
        created: false,
        reason: 'duplicate',
        existing: duplicate.identifier,
      },
    };
  const labels = await client.request<{
    issueLabels: {
      nodes: { id: string; name: string; team: { id: string } | null }[];
    };
  }>(
    `query LabelByName($filter: IssueLabelFilter) { issueLabels(first: 20, filter: $filter) { nodes { id name team { id } } } }`,
    { filter: { name: { eqIgnoreCase: options.label } } },
  );
  const label = labels.issueLabels.nodes.find(
    (candidate) =>
      candidate.team === null ||
      candidate.team.id === team.id ||
      candidate.team.id === team.parent?.id,
  );
  if (label === undefined)
    return {
      ok: false,
      summary: `No label "${options.label}" visible to ${options.team}.`,
      data: { created: false, reason: 'label' },
    };
  let stateId: string | undefined;
  if (options.state !== undefined) {
    const resolved = await resolveState(client, team, options.state);
    if (resolved.state === undefined)
      return {
        ok: false,
        summary: `${options.team} has no state "${options.state}"; it has: ${resolved.available.join(', ')}.`,
        data: {
          created: false,
          reason: 'state',
          available: resolved.available,
        },
      };
    stateId = resolved.state.id;
  }
  const created = await client.request<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string } | null;
    };
  }>(
    `mutation IssueMake($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
    {
      input: {
        teamId: team.id,
        title: options.title,
        description: options.description,
        labelIds: [label.id],
        ...(stateId === undefined ? {} : { stateId }),
        ...(options.project === undefined ? {} : { projectId: options.project }),
      },
    },
  );
  const made = created.issueCreate.issue;
  if (!created.issueCreate.success || made === null)
    return {
      ok: false,
      summary: 'The issue was not created.',
      data: { created: false, reason: 'mutation' },
    };
  const back = await client.request<{
    issue: {
      identifier: string;
      title: string;
      description: string | null;
      state: { id: string; name: string };
      labels: { nodes: { id: string }[] };
      project: { id: string } | null;
    } | null;
  }>(
    `query IssueCreated($id: String!) { issue(id: $id) { identifier title description state { id name } labels { nodes { id } } project { id } } }`,
    { id: made.id },
  );
  const issue = back.issue;
  const verified =
    issue !== null &&
    issue.title === options.title &&
    issue.labels.nodes.some((candidate) => candidate.id === label.id) &&
    (stateId === undefined || issue.state.id === stateId) &&
    (options.project === undefined || issue.project !== null) &&
    normalizeMarkdown(issue.description ?? '').includes(normalizeMarkdown(options.description));
  return {
    ok: verified,
    summary: verified
      ? `${made.identifier}: created in ${options.team} (read back).`
      : `${made.identifier}: created, but the read-back does not match what was sent.`,
    data: { created: true, identifier: made.identifier, verified },
  };
}

interface RelatedIssue {
  identifier: string;
  title: string;
  state: { name: string };
}

interface RelationRead {
  issue: {
    id: string;
    identifier: string;
    relations: { nodes: { type: string; relatedIssue: RelatedIssue }[] };
    inverseRelations: { nodes: { type: string; issue: RelatedIssue }[] };
  } | null;
}

const relationDocument = `query IssueRelations($id: String!) { issue(id: $id) { id identifier relations(first: 100) { nodes { type relatedIssue { identifier title state { name } } } } inverseRelations(first: 100) { nodes { type issue { identifier title state { name } } } } } }`;

async function fetchRelations(client: LinearClient, identifier: string) {
  const data = await client.request<RelationRead>(relationDocument, {
    id: identifier,
  });
  if (data.issue === null) throw new LinearError(`No issue ${identifier}.`);
  return {
    id: data.issue.id,
    blockedBy: data.issue.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => ({
        identifier: relation.issue.identifier,
        title: relation.issue.title,
        state: relation.issue.state.name,
      })),
    blocks: data.issue.relations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => ({
        identifier: relation.relatedIssue.identifier,
        title: relation.relatedIssue.title,
        state: relation.relatedIssue.state.name,
      })),
  };
}

export async function listBlockers(client: LinearClient, identifier: string): Promise<Outcome> {
  const { blockedBy, blocks } = await fetchRelations(client, identifier);
  const line = (entry: { identifier: string; title: string; state: string }) =>
    `  ${entry.identifier} [${entry.state}] ${entry.title}`;
  return {
    ok: true,
    summary: [
      `${identifier} is blocked by ${blockedBy.length}:`,
      ...blockedBy.map(line),
      `${identifier} blocks ${blocks.length}:`,
      ...blocks.map(line),
    ].join('\n'),
    data: { identifier, blockedBy, blocks },
  };
}

/** Make `blocker` block `identifier`, then read the relation back. */
export async function blockIssue(
  client: LinearClient,
  identifier: string,
  blocker: string,
): Promise<Outcome> {
  if (identifier === blocker) throw new UsageError('An issue cannot block itself.');
  const target = await fetchRelations(client, identifier);
  const source = await fetchRelations(client, blocker);
  let created = false;
  if (!target.blockedBy.some((entry) => entry.identifier === blocker)) {
    const result = await client.request<{
      issueRelationCreate: { success: boolean };
    }>(
      `mutation RelationMake($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
      {
        input: {
          issueId: source.id,
          relatedIssueId: target.id,
          type: 'blocks',
        },
      },
    );
    if (!result.issueRelationCreate.success)
      return {
        ok: false,
        summary: `${blocker} -> ${identifier}: the relation was not created.`,
        data: { identifier, blocker, verified: false },
      };
    created = true;
  }
  const after = await fetchRelations(client, identifier);
  const verified = after.blockedBy.some((entry) => entry.identifier === blocker);
  return {
    ok: verified,
    summary: verified
      ? `${blocker} blocks ${identifier} (${created ? 'created' : 'already present'}, read back).`
      : `${blocker} -> ${identifier}: the relation is absent on read-back.`,
    data: { identifier, blocker, created, verified },
  };
}

interface Parsed {
  positionals: string[];
  options: Map<string, string>;
  json: boolean;
}

function parse(argv: string[], names: string[]): Parsed {
  const parsed = parseOptions(argv.slice(1), { values: names, flags: ['json'] });
  return {
    positionals: parsed.positionals,
    options: new Map(Object.entries(parsed.values)),
    json: parsed.flags.has('json'),
  };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required.`);
  return value;
}

function readFileOption(parsed: Parsed): string {
  const path = required(parsed, 'file');
  if (!existsSync(path)) throw new UsageError(`No such file: ${path}`);
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') throw new UsageError(`${path} is empty.`);
  return text;
}

function identifierArgument(parsed: Parsed, count: number): string[] {
  if (parsed.positionals.length !== count)
    throw new UsageError(`Expected ${count} positional argument${count === 1 ? '' : 's'}.`);
  for (const value of parsed.positionals) {
    if (value === '') throw new UsageError('An empty argument.');
  }
  return parsed.positionals;
}

export async function run(
  argv: string[],
  dependencies: LinearDependencies = {},
): Promise<{ code: number; output: string }> {
  const command = argv[0];
  if (command === undefined)
    throw new UsageError(
      'Name a command: read, state, comment, append, create, blockers or block.',
    );
  const known = ['read', 'state', 'comment', 'append', 'create', 'blockers', 'block'];
  if (!known.includes(command)) throw new UsageError(`Unknown command ${command}.`);
  const parsed = parse(argv, ['file', 'team', 'project', 'title', 'label', 'state', 'by']);
  // Validate the arguments before any request, so a usage mistake never costs a network call.
  let plan: (client: LinearClient) => Promise<Outcome>;
  if (command === 'read') {
    const [id] = identifierArgument(parsed, 1);
    plan = (client) => readIssue(client, id as string);
  } else if (command === 'state') {
    const [id, name] = identifierArgument(parsed, 2);
    plan = (client) => setState(client, id as string, name as string);
  } else if (command === 'comment') {
    const [id] = identifierArgument(parsed, 1);
    const body = readFileOption(parsed);
    plan = (client) => postComment(client, id as string, body);
  } else if (command === 'append') {
    const [id] = identifierArgument(parsed, 1);
    const body = readFileOption(parsed);
    plan = (client) => appendDescription(client, id as string, body);
  } else if (command === 'create') {
    identifierArgument(parsed, 0);
    const options: CreateOptions = {
      team: required(parsed, 'team'),
      title: required(parsed, 'title'),
      description: readFileOption(parsed),
      label: required(parsed, 'label'),
      ...(parsed.options.has('project') ? { project: required(parsed, 'project') } : {}),
      ...(parsed.options.has('state') ? { state: required(parsed, 'state') } : {}),
    };
    plan = (client) => createIssue(client, options);
  } else if (command === 'blockers') {
    const [id] = identifierArgument(parsed, 1);
    plan = (client) => listBlockers(client, id as string);
  } else {
    const [id] = identifierArgument(parsed, 1);
    const by = required(parsed, 'by');
    plan = (client) => blockIssue(client, id as string, by);
  }
  const client = createClient(dependencies);
  try {
    const outcome = await plan(client);
    return {
      code: outcome.ok ? 0 : 1,
      output: parsed.json ? JSON.stringify({ ok: outcome.ok, ...outcome.data }) : outcome.summary,
    };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return {
      code: 1,
      output: parsed.json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
    };
  }
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
