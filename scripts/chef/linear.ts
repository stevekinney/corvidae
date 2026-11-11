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
//   bun scripts/chef/linear.ts comment <ID> --file <md> [--update <comment-id>] [--json]
//   bun scripts/chef/linear.ts append <ID> --file <md> [--json]
//   bun scripts/chef/linear.ts create --team <KEY> [--project <id>] --title <t> --file <md> --label <name>
//                                [--state <name>] [--json]
//   bun scripts/chef/linear.ts blockers <ID> [--json]
//   bun scripts/chef/linear.ts block <ID> --by <ID> [--json]
//   bun scripts/chef/linear.ts project-read <project> [--json]
//   bun scripts/chef/linear.ts project-state <project> <State Name> [--json]
//   bun scripts/chef/linear.ts project-update <project> --health <onTrack|atRisk|offTrack> --file <md> [--json]
//   bun scripts/chef/linear.ts claim <ID> --run <id> --branch <branch> [--head <sha>] [--json]
//   bun scripts/chef/linear.ts claim <ID> --release --run <id> [--json]
//   bun scripts/chef/linear.ts lease <project> --run <id> [--json]
//   bun scripts/chef/linear.ts lease <project> --release --run <id> [--json]
//
// A claim makes "who holds this issue" a checkable fact. `claim` reads the issue's newest claim
// comment (a comment whose first line is `Claim: run <run>, branch <branch>, since <ISO>,
// checkpoint <ISO>, head <sha|none>, status <held|released>`), refuses (exit 1, naming the
// holder) when it is live and another run's, and otherwise writes the claim, in place when it is
// this run's own (so each checkpoint updates `checkpoint` and `head`, never adds a comment),
// moves the issue to In Progress, and reads both back. A claim is live while its status is held
// and its checkpoint is under `claimExpiryHours` (24) old; a holder that stops checkpointing
// loses it. After writing, it reads the comments again and refuses if another run's claim is
// newer than its own, so two simultaneous claims leave one holder. `--release` marks this run's
// claim released in place and changes no state; `<run>` is the chef run's note name, such as
// 2026-11-10-134500-sdlc-efficiency. `brief.ts` prints the live claim and refuses another run's.
//
// A lease does the same for a project: at most one coordinator at a time. The marker is a native
// project status update (what `project-update` writes, so `project-read` reads it back) whose first
// line is `Lease: run <run>, since <ISO>, renewed <ISO>, status <held|released>`. `lease` reads the
// project's newest such update, refuses (exit 1, naming the holder) when it is held and renewed
// under `leaseExpiryHours` (12) ago by another run, and otherwise posts a held update (running it
// again is the renewal; `since` is kept). `--release` posts a released one. The update carries the
// project's current health, so the lease never changes the status the project shows.
//
// `read` prints the summary line, the last three comments' first lines, then the full description
// (`--json` adds it as `description`).
// `create` refuses (exit 1) when an issue with the same title already exists in the project, or in
// the team when no project is named. `block <ID> --by <OTHER>` makes OTHER block ID.
// `comment --update <comment-id>` replaces that comment's body instead of posting a new one, and
// refuses (exit 1) a comment on another issue or one that another user wrote.
//
// `<project>` is a project id, slug id or exact name; an unknown or ambiguous name is exit 1 naming
// the candidates. `project-read` prints the project's name, status, the health of its latest
// update, its lease, and its issue counts by state type (completed, started, unstarted, backlog, canceled),
// and refuses (exit 1) to report a count it could not read whole. `project-state` resolves the
// status by name from the workspace's project statuses (a project status, not an issue state),
// refuses an unknown name listing the available ones, sets it and reads it back.
// `project-update` posts a native project status update with the given health and body, and reads
// it back (body compared as `normalizeMarkdown` normalizes it, health equal). The body must carry
// each of these count lines, at the start of a line (a list marker or bold may precede it):
// "Open:", "Ready:", "Done this run:", "Batches merged:", "Batches running:", "Blockers:"; a body
// without one, or a health other than onTrack, atRisk or offTrack, is exit 2 before any request.
//
// Exit codes: 0 success and read back, 1 refused, not found, API failure or read-back mismatch,
// 2 invalid CLI usage (including an unavailable LINEAR_API_KEY).

import { existsSync, readFileSync } from 'node:fs';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import { isUsableValue, resolveCredential } from './credentials.ts';
import { describeError, emitResult, parseOptions, UsageError } from './process-runner.ts';

/** The API rejected a request or answered with something unusable. */
export class LinearError extends Error {}

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearDependencies {
  fetch?: FetchLike;
  environment?: Record<string, string | undefined>;
  /** Finds the key when the environment lacks it; defaults to `credentials.ts`'s lookup. */
  resolveKey?: () => string | undefined;
  /** The clock `claim`, `lease` and `brief.ts` judge a marker's age by; defaults to the real one. */
  now?: () => Date;
}

export interface LinearClient {
  request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

/** A client over the injected `fetch`; the key goes only into the Authorization header. */
export function createClient(dependencies: LinearDependencies = {}): LinearClient {
  const send: FetchLike = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const environment = dependencies.environment ?? rootScriptEnvironment();
  const resolveKey = dependencies.resolveKey ?? (() => resolveCredential('LINEAR_API_KEY').value);
  return {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      // A value that is not printable ASCII would be echoed whole by the HTTP layer's error.
      const fromEnvironment = environment['LINEAR_API_KEY'];
      const environmentRejected =
        fromEnvironment !== undefined && fromEnvironment !== '' && !isUsableValue(fromEnvironment);
      const key = fromEnvironment && !environmentRejected ? fromEnvironment : resolveKey();
      if (key === undefined || key === '' || !isUsableValue(key))
        throw new UsageError(
          `LINEAR_API_KEY is unavailable: it is not in the environment, the macOS Keychain (service linear-api) or a .env file; see credentials.ts.${environmentRejected ? ' The value in the environment is not printable ASCII without whitespace, so it was ignored.' : ''}`,
        );
      let response: Response;
      try {
        response = await send(LINEAR_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: key },
          body: JSON.stringify({ query: document, variables }),
        });
      } catch (error) {
        // The HTTP layer's message can quote the Authorization value, so report the name only.
        throw new LinearError(`Linear request failed (${describeError(error)}).`);
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

/**
 * Normalizes a Markdown table row, and returns any other line unchanged. A table row, trimmed,
 * starts and ends with a pipe or is a delimiter row (only pipes, dashes, colons and spaces, with
 * a pipe and a dash). Linear shortens a delimiter's `---` to `--` and re-pads cells, so a
 * delimiter's dash runs become one dash and the spacing around every pipe is dropped.
 */
function normalizeTableRow(line: string): string {
  const trimmed = line.trim();
  const delimiter = /^[\s|:-]*-[\s|:-]*$/.test(trimmed) && trimmed.includes('|');
  const row = trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|');
  if (!delimiter && !row) return line;
  const cells = delimiter ? trimmed.replace(/-+/g, '-') : trimmed;
  return cells.replace(/[ \t]*\|[ \t]*/g, '|');
}

/** Linear rewrites Markdown (escapes, list markers, table rules, spacing), so writes are compared in this form. */
export function normalizeMarkdown(text: string): string {
  return (
    text
      .replace(/ /g, ' ')
      .replace(/^(\s*)[*+] /gm, '$1- ')
      // Table normalization applies to table rows only; every other line is compared as written.
      .replace(/^.*$/gm, normalizeTableRow)
      .replace(/\\(?=[^A-Za-z0-9\s])/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function firstLine(text: string, limit = 120): string {
  const line = (text.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { id: string; name: string };
  team: { id: string; key: string; parent: { id: string } | null };
}

const issueFields = `id identifier title description updatedAt state { id name } team { id key parent { id } }`;

export async function fetchIssue(client: LinearClient, identifier: string): Promise<IssueSummary> {
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

/** Pages of 100 comments read before `fetchComments` gives up rather than return a partial list. */
export const commentPageLimit = 100;

export async function fetchComments(
  client: LinearClient,
  identifier: string,
): Promise<CommentSummary[]> {
  const comments: CommentSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < commentPageLimit; page += 1) {
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
    if (!data.issue.comments.pageInfo.hasNextPage) {
      // The API's default order is not guaranteed, so "the last three" is decided here.
      return comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    after = data.issue.comments.pageInfo.endCursor;
  }
  // A partial list would misreport the count and the last comments, so stop instead.
  throw new LinearError(
    `${identifier} has more than ${commentPageLimit * 100} comments; refusing to report a partial list.`,
  );
}

export interface Outcome {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
}

export async function readIssue(client: LinearClient, identifier: string): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const comments = await fetchComments(client, identifier);
  const description = issue.description ?? '';
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
      // The whole body follows the summary, so a worker reads appended revisions here too.
      ...(description === '' ? [] : ['', description]),
    ].join('\n'),
    data: {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state.name,
      updatedAt: issue.updatedAt,
      comments: comments.length,
      lastComments: last,
      description,
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
): Promise<{ state?: WorkflowState | undefined; available: string[] }> {
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
    normalizeMarkdown(back.comment.body) === normalizeMarkdown(body) &&
    back.comment.issue?.identifier === issue.identifier;
  return {
    ok: verified,
    summary: verified
      ? `${identifier}: comment ${id} posted (read back).`
      : `${identifier}: comment ${id} read-back mismatch.`,
    data: { identifier, commentId: id, verified },
  };
}

/**
 * Replace the body of comment `commentId` on `identifier`, then read it back. Refuses a comment on
 * another issue, and one that another user wrote, so a resumed run never overwrites someone
 * else's record.
 */
export async function updateComment(
  client: LinearClient,
  identifier: string,
  commentId: string,
  body: string,
): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const owner = await client.request<{
    viewer: { id: string };
    comment: {
      id: string;
      user: { id: string } | null;
      issue: { identifier: string } | null;
    } | null;
  }>(
    `query CommentOwner($id: String!) { viewer { id } comment(id: $id) { id user { id } issue { identifier } } }`,
    { id: commentId },
  );
  const refuse = (reason: string): Outcome => ({
    ok: false,
    summary: `${identifier}: comment ${commentId} ${reason}; nothing was changed.`,
    data: { identifier, commentId, updated: false, reason },
  });
  if (owner.comment === null) return refuse('does not exist');
  if (owner.comment.issue?.identifier !== issue.identifier)
    return refuse(`belongs to ${owner.comment.issue?.identifier ?? 'no issue'}`);
  if (owner.comment.user?.id !== owner.viewer.id) return refuse('was written by another user');
  const updated = await client.request<{ commentUpdate: { success: boolean } }>(
    `mutation CommentUpdate($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }`,
    { id: commentId, body },
  );
  const back = await client.request<{ comment: { id: string; body: string } | null }>(
    `query CommentRead($id: String!) { comment(id: $id) { id body issue { identifier } } }`,
    { id: commentId },
  );
  const verified =
    updated.commentUpdate.success &&
    back.comment !== null &&
    normalizeMarkdown(back.comment.body) === normalizeMarkdown(body);
  return {
    ok: verified,
    summary: verified
      ? `${identifier}: comment ${commentId} updated (read back).`
      : `${identifier}: comment ${commentId} read-back mismatch.`,
    data: { identifier, commentId, updated: updated.commentUpdate.success, verified },
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
  state: { name: string; type: string };
}

interface PageInfo {
  hasNextPage: boolean;
}

interface RelationRead {
  issue: {
    id: string;
    identifier: string;
    relations: { nodes: { type: string; relatedIssue: RelatedIssue }[]; pageInfo: PageInfo };
    inverseRelations: { nodes: { type: string; issue: RelatedIssue }[]; pageInfo: PageInfo };
  } | null;
}

const relationDocument = `query IssueRelations($id: String!) { issue(id: $id) { id identifier relations(first: 100) { nodes { type relatedIssue { identifier title state { name type } } } pageInfo { hasNextPage } } inverseRelations(first: 100) { nodes { type issue { identifier title state { name type } } } pageInfo { hasNextPage } } } }`;

async function fetchRelations(client: LinearClient, identifier: string) {
  const data = await client.request<RelationRead>(relationDocument, {
    id: identifier,
  });
  if (data.issue === null) throw new LinearError(`No issue ${identifier}.`);
  // Only the first 100 of each direction are read; a blocker list that silently omits some would
  // let a blocked issue look unblocked.
  if (data.issue.relations.pageInfo.hasNextPage || data.issue.inverseRelations.pageInfo.hasNextPage)
    throw new LinearError(
      `${identifier} has more than 100 relations in one direction; refusing to report a partial list.`,
    );
  return {
    id: data.issue.id,
    blockedBy: data.issue.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => ({
        identifier: relation.issue.identifier,
        title: relation.issue.title,
        state: relation.issue.state.name,
        stateType: relation.issue.state.type,
      })),
    blocks: data.issue.relations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => ({
        identifier: relation.relatedIssue.identifier,
        title: relation.relatedIssue.title,
        state: relation.relatedIssue.state.name,
        stateType: relation.relatedIssue.state.type,
      })),
  };
}

/** An issue that blocks another, with its state's name and its type (`completed`, `canceled`, …). */
export interface Blocker {
  identifier: string;
  title: string;
  state: string;
  stateType: string;
}

/**
 * The issues blocking `identifier` that are still open. Only a blocker whose state type is
 * `completed` clears; a canceled or duplicate blocker stays open, because whether it still blocks
 * is the owner's call, not a silent release. Throws `LinearError` rather than return a partial list.
 */
export async function openBlockers(client: LinearClient, identifier: string): Promise<Blocker[]> {
  const { blockedBy } = await fetchRelations(client, identifier);
  return blockedBy.filter((blocker) => blocker.stateType !== 'completed');
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

/** Pages of 100 read before a project listing or issue count gives up rather than report a partial one. */
export const projectPageLimit = 100;

/** The count lines a project status update must carry, each at the start of a line. */
export const projectUpdateCountLines = [
  'Open:',
  'Ready:',
  'Done this run:',
  'Batches merged:',
  'Batches running:',
  'Blockers:',
] as const;

/** The health values Linear accepts on a project update. */
export const projectHealthValues = ['onTrack', 'atRisk', 'offTrack'] as const;
export type ProjectHealth = (typeof projectHealthValues)[number];

function isProjectHealth(value: string): value is ProjectHealth {
  return (projectHealthValues as readonly string[]).includes(value);
}

/** The count lines `body` lacks. A line may start with a list marker and bold markers. */
export function missingCountLines(body: string): string[] {
  const lines = body.split('\n').map((line) => line.replace(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?/, ''));
  return projectUpdateCountLines.filter((label) => !lines.some((line) => line.startsWith(label)));
}

interface PagedNodes<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Follows `fetchPage` until the last page; throws rather than return a partial list. */
async function collectPages<T>(
  what: string,
  fetchPage: (after: string | null) => Promise<PagedNodes<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < projectPageLimit; page += 1) {
    const data: PagedNodes<T> = await fetchPage(after);
    all.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) return all;
    after = data.pageInfo.endCursor;
  }
  throw new LinearError(
    `More than ${projectPageLimit * 100} ${what}; refusing to report a partial list.`,
  );
}

interface ProjectReference {
  id: string;
  name: string;
  slugId: string;
}

/**
 * The project a user named by id, slug id or exact name. An unknown or ambiguous name throws
 * `LinearError` naming the candidates, so a write never lands on a guess.
 */
async function resolveProject(client: LinearClient, reference: string): Promise<ProjectReference> {
  const projects = await collectPages<ProjectReference>('projects', async (after) => {
    const data = await client.request<{ projects: PagedNodes<ProjectReference> }>(
      `query ProjectList($after: String) { projects(first: 100, after: $after) { nodes { id name slugId } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    return data.projects;
  });
  const wanted = reference.trim();
  const byIdentity = projects.filter(
    (project) => project.id === wanted || project.slugId === wanted,
  );
  const matches =
    byIdentity.length > 0
      ? byIdentity
      : projects.filter((project) => project.name.trim().toLowerCase() === wanted.toLowerCase());
  const describe = (candidates: ProjectReference[]) =>
    candidates.map((project) => `"${project.name}" (${project.slugId})`).join(', ');
  if (matches.length === 1) return matches[0] as ProjectReference;
  if (matches.length > 1)
    throw new LinearError(`"${reference}" is ambiguous; it matches ${describe(matches)}.`);
  const near = projects.filter((project) =>
    project.name.toLowerCase().includes(wanted.toLowerCase()),
  );
  const candidates = near.length > 0 ? near : projects.slice(0, 20);
  throw new LinearError(
    `No project "${reference}"; ${near.length > 0 ? 'similar' : 'available'}: ${describe(candidates)}.`,
  );
}

interface ProjectSnapshot {
  id: string;
  name: string;
  slugId: string;
  status: { id: string; name: string } | null;
  lastUpdate: { id: string; health: string | null } | null;
}

async function fetchProject(client: LinearClient, id: string): Promise<ProjectSnapshot> {
  const data = await client.request<{ project: ProjectSnapshot | null }>(
    `query ProjectRead($id: String!) { project(id: $id) { id name slugId status { id name } lastUpdate { id health } } }`,
    { id },
  );
  if (data.project === null || data.project === undefined)
    throw new LinearError(`No project ${id}.`);
  return data.project;
}

/** The state types an issue count reports; any other type is counted under `other`. */
const issueStateTypes = ['completed', 'started', 'unstarted', 'backlog', 'canceled'] as const;

async function countProjectIssues(
  client: LinearClient,
  id: string,
): Promise<Record<(typeof issueStateTypes)[number] | 'other', number>> {
  const issues = await collectPages<{ state: { type: string } }>(
    'issues in the project',
    async (after) => {
      const data = await client.request<{
        project: { issues: PagedNodes<{ state: { type: string } }> } | null;
      }>(
        `query ProjectIssues($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after) { nodes { state { type } } pageInfo { hasNextPage endCursor } } } }`,
        { id, after },
      );
      if (data.project === null) throw new LinearError(`No project ${id}.`);
      return data.project.issues;
    },
  );
  const counts = { completed: 0, started: 0, unstarted: 0, backlog: 0, canceled: 0, other: 0 };
  for (const issue of issues) {
    const type = issueStateTypes.find((candidate) => candidate === issue.state.type) ?? 'other';
    counts[type] += 1;
  }
  return counts;
}

/** The project's name, status, the health of its latest update, and its issue counts by state type. */
export async function readProject(
  client: LinearClient,
  reference: string,
  now: Date = new Date(),
): Promise<Outcome> {
  const resolved = await resolveProject(client, reference);
  const project = await fetchProject(client, resolved.id);
  const counts = await countProjectIssues(client, resolved.id);
  const lease = await latestLease(client, resolved.id);
  const health = project.lastUpdate?.health ?? 'none';
  const status = project.status?.name ?? 'none';
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    ok: true,
    summary: [
      `${project.name}: status=${status} health=${health} issues=${total}`,
      `  lease: ${describeLease(lease, now)}`,
      `  completed=${counts.completed} started=${counts.started} unstarted=${counts.unstarted} backlog=${counts.backlog} canceled=${counts.canceled}${counts.other > 0 ? ` other=${counts.other}` : ''}`,
    ].join('\n'),
    data: {
      project: project.name,
      id: project.id,
      slugId: project.slugId,
      status,
      health,
      lease: lease === undefined ? null : { ...lease.marker, live: leaseIsLive(lease.marker, now) },
      issues: total,
      counts,
    },
  };
}

interface ProjectStatus {
  id: string;
  name: string;
}

/** Set the project's status by name from the workspace's project statuses, then read it back. */
export async function setProjectState(
  client: LinearClient,
  reference: string,
  statusName: string,
): Promise<Outcome> {
  const resolved = await resolveProject(client, reference);
  const statuses = await collectPages<ProjectStatus>('project statuses', async (after) => {
    const data = await client.request<{ projectStatuses: PagedNodes<ProjectStatus> }>(
      `query ProjectStatuses($after: String) { projectStatuses(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    return data.projectStatuses;
  });
  const wanted = statusName.trim().toLowerCase();
  const status = statuses.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
  if (status === undefined) {
    const available = statuses.map((candidate) => candidate.name).toSorted();
    return {
      ok: false,
      summary: `No project status "${statusName}"; it has: ${available.join(', ')}.`,
      data: { project: resolved.name, requested: statusName, updated: false, available },
    };
  }
  const before = await fetchProject(client, resolved.id);
  const result = await client.request<{ projectUpdate: { success: boolean } }>(
    `mutation ProjectSetStatus($id: String!, $statusId: String!) { projectUpdate(id: $id, input: { statusId: $statusId }) { success } }`,
    { id: resolved.id, statusId: status.id },
  );
  const after = await fetchProject(client, resolved.id);
  const verified = result.projectUpdate.success && after.status?.id === status.id;
  return {
    ok: verified,
    summary: verified
      ? `${resolved.name}: ${before.status?.name ?? 'none'} -> ${status.name} (read back).`
      : `${resolved.name}: read-back mismatch; the status is ${after.status?.name ?? 'none'}, expected ${status.name}.`,
    data: {
      project: resolved.name,
      from: before.status?.name ?? null,
      to: after.status?.name ?? null,
      requested: status.name,
      verified,
    },
  };
}

/** Create a project status update with `health` and `body`, then read it back. */
export async function postProjectUpdate(
  client: LinearClient,
  reference: string,
  health: ProjectHealth,
  body: string,
): Promise<Outcome> {
  const resolved = await resolveProject(client, reference);
  return createProjectUpdate(client, resolved, health, body);
}

/** Posts the update to an already resolved project; no `health` leaves the project's health alone. */
async function createProjectUpdate(
  client: LinearClient,
  resolved: ProjectReference,
  health: ProjectHealth | undefined,
  body: string,
): Promise<Outcome> {
  const created = await client.request<{
    projectUpdateCreate: { success: boolean; projectUpdate: { id: string } | null };
  }>(
    `mutation ProjectUpdateMake($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { id } } }`,
    { input: { projectId: resolved.id, ...(health === undefined ? {} : { health }), body } },
  );
  const id = created.projectUpdateCreate.projectUpdate?.id;
  if (!created.projectUpdateCreate.success || id === undefined)
    return {
      ok: false,
      summary: `${resolved.name}: the project update was not created.`,
      data: { project: resolved.name, verified: false },
    };
  const back = await client.request<{
    projectUpdate: {
      id: string;
      body: string;
      health: string;
      project: { id: string } | null;
    } | null;
  }>(
    `query ProjectUpdateRead($id: String!) { projectUpdate(id: $id) { id body health project { id } } }`,
    { id },
  );
  const update = back.projectUpdate;
  const verified =
    update !== null &&
    (health === undefined || update.health === health) &&
    update.project?.id === resolved.id &&
    normalizeMarkdown(update.body) === normalizeMarkdown(body);
  return {
    ok: verified,
    summary: verified
      ? `${resolved.name}: project update ${id} posted${health === undefined ? '' : ` with health ${health}`} (read back).`
      : `${resolved.name}: project update ${id} read-back mismatch.`,
    data: { project: resolved.name, updateId: id, health: health ?? null, verified },
  };
}

// Claims and leases -----------------------------------------------------------------------------

/** A claim with no checkpoint for this long is no longer held: its holder is presumed gone. */
export const claimExpiryHours = 24;
/** A lease not renewed for this long is no longer held; a coordinator renews at every batch. */
export const leaseExpiryHours = 12;

const hourMilliseconds = 3_600_000;
const isoTime = String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+Z`;

/** The line a claim or lease marker is read from: the first non-empty line, escapes removed. */
function markerLine(body: string): string {
  const line = (body.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
  return line.replace(/\\(?=[^A-Za-z0-9\s])/g, '');
}

function isLive(status: string, since: string, hours: number, now: Date): boolean {
  const age = now.getTime() - Date.parse(since);
  return status === 'held' && Number.isFinite(age) && age < hours * hourMilliseconds;
}

export interface ClaimMarker {
  run: string;
  branch: string;
  since: string;
  checkpoint: string;
  /** The branch's last pushed head, or `none` before the first push. */
  head: string;
  status: 'held' | 'released';
}

export function formatClaim(marker: ClaimMarker): string {
  return `Claim: run ${marker.run}, branch ${marker.branch}, since ${marker.since}, checkpoint ${marker.checkpoint}, head ${marker.head}, status ${marker.status}`;
}

const claimPattern = new RegExp(
  String.raw`^Claim: run ([^\s,]+), branch ([^\s,]+), since (${isoTime}), checkpoint (${isoTime}), head (\S+), status (held|released)$`,
);

/** The claim a comment body opens with, or nothing when its first line is not a claim line. */
export function parseClaim(body: string): ClaimMarker | undefined {
  const match = claimPattern.exec(markerLine(body));
  if (match === null) return undefined;
  return {
    run: match[1] as string,
    branch: match[2] as string,
    since: match[3] as string,
    checkpoint: match[4] as string,
    head: match[5] as string,
    status: match[6] as 'held' | 'released',
  };
}

export function claimIsLive(marker: ClaimMarker, now: Date): boolean {
  return isLive(marker.status, marker.checkpoint, claimExpiryHours, now);
}

export interface ClaimRecord {
  commentId: string;
  marker: ClaimMarker;
}

/** The newest claim among `comments` (oldest first, as `fetchComments` returns them). */
export function latestClaim(comments: CommentSummary[]): ClaimRecord | undefined {
  for (const comment of comments.toReversed()) {
    const marker = parseClaim(comment.body);
    if (marker !== undefined) return { commentId: comment.id, marker };
  }
  return undefined;
}

/** One line saying who holds an issue, for a person or a brief. */
export function describeClaim(record: ClaimRecord | undefined, now: Date): string {
  if (record === undefined) return 'none';
  const { marker } = record;
  if (marker.status === 'released')
    return `released by run ${marker.run} (branch ${marker.branch}, checkpoint ${marker.checkpoint})`;
  if (!claimIsLive(marker, now))
    return `expired: run ${marker.run} on branch ${marker.branch} last checkpointed ${marker.checkpoint}, over ${claimExpiryHours} hours ago`;
  return `held by run ${marker.run} on branch ${marker.branch} since ${marker.since}, last checkpoint ${marker.checkpoint}, head ${marker.head}`;
}

/**
 * Take, or checkpoint, this run's claim on `identifier`: refuse when another run's claim is live,
 * write the claim comment (this run's own is updated in place), move the issue to In Progress, and
 * read back. A claim by another run that landed between the read and the write and is newer than
 * this one wins, and this call refuses.
 */
export async function claimIssue(
  client: LinearClient,
  identifier: string,
  options: { run: string; branch: string; head?: string | undefined },
  now: Date,
): Promise<Outcome> {
  const issue = await fetchIssue(client, identifier);
  const current = latestClaim(await fetchComments(client, identifier));
  const refuse = (holder: ClaimRecord | undefined, wrote = false): Outcome => ({
    ok: false,
    summary: `Refused: ${identifier} is ${describeClaim(holder, now)}; ${wrote ? "this run's claim comment was written first and is superseded, and the state was not changed" : 'nothing was changed'}.`,
    data: { identifier, claimed: false, holder: holder?.marker.run ?? null },
  });
  if (
    current !== undefined &&
    current.marker.run !== options.run &&
    claimIsLive(current.marker, now)
  )
    return refuse(current);
  const own = current?.marker.run === options.run ? current : undefined;
  const held = own !== undefined && own.marker.status === 'held';
  const marker: ClaimMarker = {
    run: options.run,
    branch: options.branch,
    since: held ? own.marker.since : now.toISOString(),
    checkpoint: now.toISOString(),
    head:
      options.head ??
      (own !== undefined && own.marker.branch === options.branch ? own.marker.head : 'none'),
    status: 'held',
  };
  const body = `${formatClaim(marker)}\n\nWritten by scripts/chef/linear.ts claim; the first line is the record. Update it with the same command at each checkpoint, release it with --release.`;
  const written =
    own === undefined
      ? await postComment(client, identifier, body)
      : await updateComment(client, identifier, own.commentId, body);
  if (!written.ok) return written;
  const after = latestClaim(await fetchComments(client, identifier));
  if (after?.marker.run !== options.run) return refuse(after, true);
  const state =
    issue.state.name === 'In Progress'
      ? undefined
      : await setState(client, identifier, 'In Progress');
  if (state !== undefined && !state.ok) return state;
  return {
    ok: true,
    summary: `${identifier}: claimed by run ${options.run} on branch ${options.branch}, head ${marker.head}, In Progress (read back).`,
    data: { identifier, claimed: true, ...marker, state: 'In Progress' },
  };
}

/** Mark this run's claim on `identifier` released in place; the issue's state is not touched. */
export async function releaseClaim(
  client: LinearClient,
  identifier: string,
  runId: string,
  now: Date,
): Promise<Outcome> {
  const current = latestClaim(await fetchComments(client, identifier));
  if (current === undefined || current.marker.run !== runId)
    return {
      ok: false,
      summary: `Refused: ${identifier} has no claim by run ${runId}; it is ${describeClaim(current, now)}.`,
      data: { identifier, released: false, holder: current?.marker.run ?? null },
    };
  if (current.marker.status === 'released')
    return {
      ok: true,
      summary: `${identifier}: the claim by run ${runId} was already released.`,
      data: { identifier, released: true },
    };
  const marker: ClaimMarker = {
    ...current.marker,
    checkpoint: now.toISOString(),
    status: 'released',
  };
  const written = await updateComment(
    client,
    identifier,
    current.commentId,
    `${formatClaim(marker)}\n\nReleased by scripts/chef/linear.ts claim --release.`,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    summary: `${identifier}: claim by run ${runId} released (read back).`,
    data: { identifier, released: true },
  };
}

export interface LeaseMarker {
  run: string;
  since: string;
  renewed: string;
  status: 'held' | 'released';
}

export function formatLease(marker: LeaseMarker): string {
  return `Lease: run ${marker.run}, since ${marker.since}, renewed ${marker.renewed}, status ${marker.status}`;
}

const leasePattern = new RegExp(
  String.raw`^Lease: run ([^\s,]+), since (${isoTime}), renewed (${isoTime}), status (held|released)$`,
);

/** The lease a project update body opens with, or nothing when its first line is not a lease line. */
export function parseLease(body: string): LeaseMarker | undefined {
  const match = leasePattern.exec(markerLine(body));
  if (match === null) return undefined;
  return {
    run: match[1] as string,
    since: match[2] as string,
    renewed: match[3] as string,
    status: match[4] as 'held' | 'released',
  };
}

export function leaseIsLive(marker: LeaseMarker, now: Date): boolean {
  return isLive(marker.status, marker.renewed, leaseExpiryHours, now);
}

interface LeaseRecord {
  updateId: string;
  marker: LeaseMarker;
}

/** The newest lease marker among all of the project's updates. */
async function latestLease(
  client: LinearClient,
  projectId: string,
): Promise<LeaseRecord | undefined> {
  // Every page, newest or not, so the answer does not depend on the order Linear lists them in.
  const updates = await collectPages<{ id: string; body: string; createdAt: string }>(
    'project updates',
    async (after) => {
      const data = await client.request<{
        project: {
          projectUpdates: PagedNodes<{ id: string; body: string; createdAt: string }>;
        } | null;
      }>(
        `query ProjectUpdates($id: String!, $after: String) { project(id: $id) { projectUpdates(first: 50, after: $after, orderBy: createdAt) { nodes { id body createdAt } pageInfo { hasNextPage endCursor } } } }`,
        { id: projectId, after },
      );
      if (data.project === null || data.project === undefined)
        throw new LinearError(`No project ${projectId}.`);
      return data.project.projectUpdates;
    },
  );
  const newest = updates.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const update of newest) {
    const marker = parseLease(update.body);
    if (marker !== undefined) return { updateId: update.id, marker };
  }
  return undefined;
}

/** The health of the project's latest update, so a lease update never changes the health it shows. */
async function inheritedHealth(
  client: LinearClient,
  projectId: string,
): Promise<ProjectHealth | undefined> {
  const project = await fetchProject(client, projectId);
  const health = project.lastUpdate?.health;
  return health !== null && health !== undefined && isProjectHealth(health) ? health : undefined;
}

function describeLease(record: LeaseRecord | undefined, now: Date): string {
  if (record === undefined) return 'none';
  const { marker } = record;
  if (marker.status === 'released') return `released by run ${marker.run} at ${marker.renewed}`;
  if (!leaseIsLive(marker, now))
    return `expired: run ${marker.run} last renewed ${marker.renewed}, over ${leaseExpiryHours} hours ago`;
  return `held by run ${marker.run} since ${marker.since}, renewed ${marker.renewed}`;
}

/** Take or renew this run's lease on the project; refuse while another run's is live. */
export async function leaseProject(
  client: LinearClient,
  reference: string,
  runId: string,
  now: Date,
): Promise<Outcome> {
  const resolved = await resolveProject(client, reference);
  const current = await latestLease(client, resolved.id);
  const refuse = (holder: LeaseRecord | undefined, wrote = false): Outcome => ({
    ok: false,
    summary: `Refused: ${resolved.name} lease is ${describeLease(holder, now)}; ${wrote ? "this run's lease update was posted first and is superseded" : 'nothing was changed'}.`,
    data: { project: resolved.name, leased: false, holder: holder?.marker.run ?? null },
  });
  if (current !== undefined && current.marker.run !== runId && leaseIsLive(current.marker, now))
    return refuse(current);
  const kept = current?.marker.run === runId && current.marker.status === 'held';
  const marker: LeaseMarker = {
    run: runId,
    since: kept ? current.marker.since : now.toISOString(),
    renewed: now.toISOString(),
    status: 'held',
  };
  const written = await createProjectUpdate(
    client,
    resolved,
    await inheritedHealth(client, resolved.id),
    `${formatLease(marker)}\n\nWritten by scripts/chef/linear.ts lease. Run it again to renew, with --release to end it.`,
  );
  if (!written.ok) return written;
  const after = await latestLease(client, resolved.id);
  if (after?.updateId !== written.data['updateId']) return refuse(after, true);
  return {
    ok: true,
    summary: `${resolved.name}: lease held by run ${runId} since ${marker.since}, renewed ${marker.renewed} (read back).`,
    data: { project: resolved.name, leased: true, ...marker },
  };
}

/** End this run's lease on the project; refuse when another run holds it or none is recorded. */
export async function releaseLease(
  client: LinearClient,
  reference: string,
  runId: string,
  now: Date,
): Promise<Outcome> {
  const resolved = await resolveProject(client, reference);
  const current = await latestLease(client, resolved.id);
  if (current === undefined || current.marker.run !== runId)
    return {
      ok: false,
      summary: `Refused: ${resolved.name} has no lease held by run ${runId}; it is ${describeLease(current, now)}.`,
      data: { project: resolved.name, released: false, holder: current?.marker.run ?? null },
    };
  if (current.marker.status === 'released')
    return {
      ok: true,
      summary: `${resolved.name}: the lease of run ${runId} was already released.`,
      data: { project: resolved.name, released: true },
    };
  const written = await createProjectUpdate(
    client,
    resolved,
    await inheritedHealth(client, resolved.id),
    `${formatLease({ ...current.marker, renewed: now.toISOString(), status: 'released' })}\n\nReleased by scripts/chef/linear.ts lease --release.`,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    summary: `${resolved.name}: lease of run ${runId} released (read back).`,
    data: { project: resolved.name, released: true },
  };
}

interface Parsed {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
  json: boolean;
}

function parse(argv: string[], names: string[]): Parsed {
  const parsed = parseOptions(argv.slice(1), { values: names, flags: ['json', 'release'] });
  return {
    positionals: parsed.positionals,
    options: new Map(Object.entries(parsed.values)),
    flags: parsed.flags,
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
      'Name a command: read, state, comment, append, create, blockers, block, project-read, project-state, project-update, claim or lease.',
    );
  const known = [
    'read',
    'state',
    'comment',
    'append',
    'create',
    'blockers',
    'block',
    'project-read',
    'project-state',
    'project-update',
    'claim',
    'lease',
  ];
  if (!known.includes(command)) throw new UsageError(`Unknown command ${command}.`);
  const parsed = parse(argv, [
    'file',
    'team',
    'project',
    'title',
    'label',
    'state',
    'by',
    'update',
    'health',
    'run',
    'branch',
    'head',
  ]);
  if (command !== 'comment' && parsed.options.has('update'))
    throw new UsageError('--update applies only to comment.');
  if (command !== 'project-update' && parsed.options.has('health'))
    throw new UsageError('--health applies only to project-update.');
  const claimLike = command === 'claim' || command === 'lease';
  if (!claimLike && parsed.flags.has('release'))
    throw new UsageError('--release applies only to claim and lease.');
  for (const name of ['run', 'branch', 'head'])
    if (parsed.options.has(name) && !(claimLike && (name === 'run' || command === 'claim')))
      throw new UsageError(
        `--${name} applies only to ${name === 'run' ? 'claim and lease' : 'claim'}.`,
      );
  const now = (dependencies.now ?? (() => new Date()))();
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
    const update = parsed.options.get('update');
    if (update === '') throw new UsageError('--update needs a comment id.');
    plan = (client) =>
      update === undefined
        ? postComment(client, id as string, body)
        : updateComment(client, id as string, update, body);
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
  } else if (command === 'project-read') {
    const [project] = identifierArgument(parsed, 1);
    plan = (client) => readProject(client, project as string, now);
  } else if (command === 'project-state') {
    const [project, name] = identifierArgument(parsed, 2);
    plan = (client) => setProjectState(client, project as string, name as string);
  } else if (command === 'project-update') {
    const [project] = identifierArgument(parsed, 1);
    const health = required(parsed, 'health');
    if (!isProjectHealth(health))
      throw new UsageError(
        `--health must be one of ${projectHealthValues.join(', ')}; got "${health}".`,
      );
    const body = readFileOption(parsed);
    const missing = missingCountLines(body);
    if (missing.length > 0)
      throw new UsageError(
        `The project update lacks the count line${missing.length === 1 ? '' : 's'}: ${missing.join(' ')}`,
      );
    plan = (client) => postProjectUpdate(client, project as string, health, body);
  } else if (command === 'claim' || command === 'lease') {
    const [target] = identifierArgument(parsed, 1);
    const runId = required(parsed, 'run');
    if (!/^[\w.-]+$/.test(runId))
      throw new UsageError(`--run needs a run id such as 2026-11-10-134500-name, not "${runId}".`);
    const release = parsed.flags.has('release');
    if (command === 'lease') {
      plan = (client) =>
        release
          ? releaseLease(client, target as string, runId, now)
          : leaseProject(client, target as string, runId, now);
    } else if (release) {
      if (parsed.options.has('branch') || parsed.options.has('head'))
        throw new UsageError('--release takes no --branch or --head.');
      plan = (client) => releaseClaim(client, target as string, runId, now);
    } else {
      const branch = required(parsed, 'branch');
      if (!/^[^\s,]+$/.test(branch))
        throw new UsageError(`--branch cannot hold whitespace or a comma: "${branch}".`);
      const head = parsed.options.get('head');
      if (head !== undefined && !/^[0-9a-f]{7,40}$/.test(head))
        throw new UsageError(`--head needs a commit sha, not "${head}".`);
      plan = (client) =>
        claimIssue(
          client,
          target as string,
          { run: runId, branch, ...(head === undefined ? {} : { head }) },
          now,
        );
    }
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
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
