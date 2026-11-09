#!/usr/bin/env bun
// Chef drift report: finds COR issues whose Linear state disagrees with GitHub. Nothing else notices
// an issue that is still open after its pull request merged, one In Review with no pull request left
// to review, or one that has sat in progress with no pull request and no update. It only reads: every
// Linear request is a query, and the only GitHub command is `gh pr list`.
//
// Usage (the key is LINEAR_API_KEY, resolved as `linear.ts` does; `gh` must be signed in for the
// repository of the working directory):
//   bun scripts/chef/drift.ts [--team COR] [--project <id>] [--stale-days <n>] [--json]
//
// It reads every issue in the team (or project) that is neither completed nor canceled, following
// pagination, and the repository's pull requests (`gh pr list --state all --limit 1000`). A pull
// request belongs to an issue when the issue's identifier appears in its title or branch name as a
// whole token, ignoring case (COR-12 never matches COR-123 or XCOR-12, and does match `cor-12-x`),
// or when its body references the issue with a linking word (`Refs COR-12`, `Closes COR-12, COR-13`).
// A passing mention in the body ("moved to COR-12") does not count.
// It reports one finding per issue and kind:
//   merged-open          the issue is not completed although a pull request naming it merged
//   review-without-pr    the issue is In Review (by name) with no open pull request naming it
//   stale-in-progress    the issue is in a started state other than In Review, with no open pull
//                        request naming it and no update for more than --stale-days days (default 3)
// A merged pull request is reported even when another pull request naming the issue is still open,
// so an issue that is delivered in several pull requests shows up until its last one merges.
// `gh` lists at most 1000 pull requests, newest first; when it returns that many, the report says
// the older ones were not considered.
//
// Exit codes: 0 no drift, 1 drift found, or a gh or Linear read failed (the failed read is named and
// no "No drift." is printed), 2 invalid CLI usage (including an unavailable LINEAR_API_KEY).

import { createClient, LinearError, type LinearClient, type LinearDependencies } from './linear.ts';
import {
  defaultRunner,
  describeError,
  emitResult,
  parseOptions,
  UsageError,
  type Runner,
} from './process-runner.ts';

export type FindingKind = 'merged-open' | 'review-without-pr' | 'stale-in-progress';

export interface DriftFinding {
  identifier: string;
  kind: FindingKind;
  /** The issue's Linear state name. */
  state: string;
  /** The pull request the finding rests on, when one applies. */
  pullRequest: number | null;
}

export interface OpenIssue {
  identifier: string;
  updatedAt: string;
  state: { name: string; type: string };
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  body: string;
  state: string;
  mergedAt: string | null;
}

export interface DriftDependencies extends LinearDependencies {
  runner?: Runner;
  /** The current time, injected so staleness is testable. */
  now?: () => Date;
}

/** The pull-request limit passed to `gh`; a result this long may have left older ones out. */
export const PULL_REQUEST_LIMIT = 1000;

/** Pages of 100 issues read before the report gives up rather than judge a partial list. */
export const ISSUE_PAGE_LIMIT = 100;

const DEFAULT_STALE_DAYS = 3;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const REVIEW_STATE = 'in review';

/** Whether `identifier` appears in `text` as a whole token, ignoring case. */
export function mentions(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text);
}

/**
 * The issue identifiers a pull request body references with a linking word (`Refs`, `Closes`,
 * `Fixes`, `Resolves`, and their variants), upper-cased. A list after the word counts whole:
 * `Refs COR-1, COR-2 and COR-3`. An identifier merely mentioned in prose does not count, because
 * bodies name related issues ("moved to COR-2289") that the pull request does not deliver.
 */
export function referencedIn(body: string): Set<string> {
  const found = new Set<string>();
  const clause =
    /\b(?:refs?|references?|close[sd]?|closing|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+((?:[A-Za-z][A-Za-z0-9]*-\d+(?:\s*(?:,|&|\band\b)\s*)?)+)/gi;
  for (const match of body.matchAll(clause))
    for (const identifier of (match[1] ?? '').match(/[A-Za-z][A-Za-z0-9]*-\d+/g) ?? [])
      found.add(identifier.toUpperCase());
  return found;
}

/**
 * The pull requests that belong to `identifier`: it names the issue in its title or branch name as a
 * whole token, or references it in its body with a linking word.
 */
export function pullRequestsFor(pullRequests: PullRequest[], identifier: string): PullRequest[] {
  return pullRequests.filter(
    (pullRequest) =>
      mentions(pullRequest.title, identifier) ||
      mentions(pullRequest.headRefName, identifier) ||
      referencedIn(pullRequest.body).has(identifier.toUpperCase()),
  );
}

const isMerged = (pullRequest: PullRequest) =>
  pullRequest.mergedAt !== null || pullRequest.state === 'MERGED';
const isOpen = (pullRequest: PullRequest) => pullRequest.state === 'OPEN';

/** The highest-numbered pull request, which is the latest one opened. */
function latest(pullRequests: PullRequest[]): PullRequest | undefined {
  return pullRequests.toSorted((a, b) => b.number - a.number)[0];
}

/** The findings for `issues` against `pullRequests` at `now`; the issues are all not completed. */
export function findDrift(
  issues: OpenIssue[],
  pullRequests: PullRequest[],
  now: Date,
  staleDays: number,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const issue of issues) {
    const named = pullRequestsFor(pullRequests, issue.identifier);
    const merged = latest(named.filter(isMerged));
    const open = latest(named.filter(isOpen));
    const report = (kind: FindingKind, pullRequest: PullRequest | undefined) =>
      findings.push({
        identifier: issue.identifier,
        kind,
        state: issue.state.name,
        pullRequest: pullRequest?.number ?? null,
      });
    if (merged !== undefined) report('merged-open', merged);
    const inReview = issue.state.name.trim().toLowerCase() === REVIEW_STATE;
    if (inReview && open === undefined) report('review-without-pr', undefined);
    if (issue.state.type === 'started' && !inReview && open === undefined) {
      const updated = Date.parse(issue.updatedAt);
      if (Number.isNaN(updated))
        throw new LinearError(`${issue.identifier} has an unreadable updatedAt.`);
      if (now.getTime() - updated > staleDays * DAY_MILLISECONDS)
        report('stale-in-progress', undefined);
    }
  }
  return findings.toSorted(
    (a, b) =>
      a.identifier.localeCompare(b.identifier, 'en', { numeric: true }) ||
      a.kind.localeCompare(b.kind),
  );
}

interface IssuePage {
  issues: {
    nodes: OpenIssue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Every issue of the team (or project) that is neither completed nor canceled. */
export async function fetchOpenIssues(
  client: LinearClient,
  team: string,
  project: string | undefined,
): Promise<OpenIssue[]> {
  const teams = await client.request<{ teams: { nodes: { id: string }[] } }>(
    `query DriftTeam($filter: TeamFilter) { teams(first: 1, filter: $filter) { nodes { id } } }`,
    { filter: { key: { eq: team } } },
  );
  // A mistyped team or project would otherwise read as an empty, clean report.
  if (teams.teams.nodes.length === 0) throw new LinearError(`No team ${team}.`);
  if (project !== undefined) {
    const projects = await client.request<{ projects: { nodes: { id: string }[] } }>(
      `query DriftProject($filter: ProjectFilter) { projects(first: 1, filter: $filter) { nodes { id } } }`,
      { filter: { id: { eq: project } } },
    );
    if (projects.projects.nodes.length === 0) throw new LinearError(`No project ${project}.`);
  }
  const filter = {
    team: { key: { eq: team } },
    state: { type: { nin: ['completed', 'canceled'] } },
    ...(project === undefined ? {} : { project: { id: { eq: project } } }),
  };
  const issues: OpenIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < ISSUE_PAGE_LIMIT; page += 1) {
    const data: IssuePage = await client.request<IssuePage>(
      `query DriftIssues($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter) { nodes { identifier updatedAt state { name type } } pageInfo { hasNextPage endCursor } } }`,
      { filter, after },
    );
    issues.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return issues;
    after = data.issues.pageInfo.endCursor;
  }
  throw new LinearError(
    `${team} has more than ${ISSUE_PAGE_LIMIT * 100} open issues; refusing to report from a partial list.`,
  );
}

/** A `gh` read that failed or answered with something unusable. */
export class GitHubError extends Error {}

const GITHUB_FIELDS = 'number,title,headRefName,body,state,mergedAt,updatedAt';

/** The repository's pull requests, newest first; throws `GitHubError` rather than return a partial list. */
export function fetchPullRequests(runner: Runner): PullRequest[] {
  const command = [
    'gh',
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(PULL_REQUEST_LIMIT),
    '--json',
    GITHUB_FIELDS,
  ];
  const result = runner(command);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
    throw new GitHubError(`gh pr list failed (exit ${result.code}): ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new GitHubError('gh pr list answered with output that is not JSON.');
  }
  if (!Array.isArray(parsed))
    throw new GitHubError('gh pr list answered with something that is not a list.');
  return parsed.map((entry: unknown): PullRequest => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    if (typeof item['number'] !== 'number')
      throw new GitHubError('gh pr list answered with a pull request that has no number.');
    const text = (field: string): string => {
      const value = item[field];
      return typeof value === 'string' ? value : '';
    };
    return {
      number: item['number'],
      title: text('title'),
      headRefName: text('headRefName'),
      body: text('body'),
      state: text('state'),
      mergedAt:
        typeof item['mergedAt'] === 'string' && item['mergedAt'] !== '' ? item['mergedAt'] : null,
    };
  });
}

function renderFinding(finding: DriftFinding): string {
  const pullRequest = finding.pullRequest === null ? '' : ` pr=#${finding.pullRequest}`;
  return `${finding.identifier} ${finding.kind} state=${finding.state}${pullRequest}`;
}

function parseStaleDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_STALE_DAYS;
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new UsageError('--stale-days needs a non-negative number of days.');
  return Number(value);
}

export async function run(
  argv: string[],
  dependencies: DriftDependencies = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['team', 'project', 'stale-days'],
    flags: ['json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const team = parsed.values['team'] ?? 'COR';
  if (team === '') throw new UsageError('--team needs a team key.');
  const project = parsed.values['project'];
  if (project === '') throw new UsageError('--project needs a project id.');
  const staleDays = parseStaleDays(parsed.values['stale-days']);
  const json = parsed.flags.has('json');
  const runner = dependencies.runner ?? defaultRunner;
  const now = (dependencies.now ?? (() => new Date()))();
  const client = createClient(dependencies);

  const failed = (read: string, message: string) => ({
    code: 1,
    output: json
      ? JSON.stringify({ ok: false, failedRead: read, error: message })
      : `The ${read} read failed, so no drift report was made: ${message}`,
  });
  let issues: OpenIssue[];
  try {
    issues = await fetchOpenIssues(client, team, project);
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return failed('Linear', error.message);
  }
  let pullRequests: PullRequest[];
  try {
    pullRequests = fetchPullRequests(runner);
  } catch (error) {
    return failed(
      'gh',
      error instanceof GitHubError
        ? error.message
        : `gh could not be run (${describeError(error)}).`,
    );
  }
  let findings: DriftFinding[];
  try {
    findings = findDrift(issues, pullRequests, now, staleDays);
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return failed('Linear', error.message);
  }
  const truncated = pullRequests.length >= PULL_REQUEST_LIMIT;
  const note = truncated
    ? `Note: gh returned ${PULL_REQUEST_LIMIT} pull requests, its limit; older ones were not considered.`
    : '';
  if (json)
    return {
      code: findings.length === 0 ? 0 : 1,
      output: JSON.stringify({
        ok: findings.length === 0,
        issues: issues.length,
        pullRequests: pullRequests.length,
        truncated,
        findings,
      }),
    };
  const lines =
    findings.length === 0
      ? ['No drift.']
      : [
          `Drift: ${findings.length} finding${findings.length === 1 ? '' : 's'} across ${issues.length} open issues.`,
          ...findings.map(renderFinding),
        ];
  return {
    code: findings.length === 0 ? 0 : 1,
    output: [...lines, ...(note === '' ? [] : [note])].join('\n'),
  };
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
