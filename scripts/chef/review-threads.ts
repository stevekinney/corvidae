#!/usr/bin/env bun
// Chef review threads: lists a pull request's review threads and answers-and-resolves them in
// batch, through `gh`. The listing pages through every thread (50 per page) and checks that it saw
// as many threads as GitHub says exist, because a gate that read only the first page once hid a
// dozen unresolved threads. Replies are keyed by thread id, never by comment id.
//
// Usage:
//   bun scripts/chef/review-threads.ts list <owner/repo> <pr> [--unresolved] [--json]
//   bun scripts/chef/review-threads.ts resolve <owner/repo> <pr> --file <tsv> [--json]
//
// `list` prints one line per thread (thread id, first comment's databaseId, path:line, author,
// resolved or open, first line of the first comment) and a final `SEEN=<n> TOTAL=<n>
// UNRESOLVED=<n>`. `resolve` reads `<threadId><TAB><reply>` lines (a literal `\n` in a reply
// becomes a newline), posts each reply to its thread's first comment, resolves the thread, then
// lists again and prints `RESOLVED <n>/<n>` and what remains. A thread that is already resolved is
// counted without a second reply.
//
// Exit codes: 0 every thread seen (and, for `resolve`, every target resolved), 1 SEEN differs from
// TOTAL, GitHub failed, or a target is still unresolved, 2 invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { defaultRunner, parseOptions, type Runner, UsageError } from './process-runner.ts';

export { UsageError };
export type { Runner };

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  author: string | null;
  /** The first comment's `databaseId`, the key the reply endpoint takes. */
  commentId: number | null;
  firstLine: string;
}

export interface ThreadListing {
  threads: ReviewThread[];
  seen: number;
  total: number;
  unresolved: number;
}

/** GitHub refused, failed, or answered with something that is not a thread listing. */
export class ReviewThreadsError extends Error {}

const PAGE_SIZE = 50;
const MAX_PAGES = 200;

const threadsQuery = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: ${PAGE_SIZE}, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: 1) { nodes { databaseId body author { login } } }
        }
      }
    }
  }
}`;

const resolveMutation = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

export function parseRepository(repository: string): {
  owner: string;
  name: string;
} {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (match === null) throw new UsageError(`"${repository}" is not owner/repo.`);
  return { owner: match[1] as string, name: match[2] as string };
}

export function parsePullRequest(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`"${value}" is not a pull request number.`);
  return Number(value);
}

interface ThreadNode {
  id?: unknown;
  isResolved?: unknown;
  path?: unknown;
  line?: unknown;
  originalLine?: unknown;
  comments?: {
    nodes?: {
      databaseId?: unknown;
      body?: unknown;
      author?: { login?: unknown } | null;
    }[];
  };
}

interface ThreadsPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          totalCount?: unknown;
          pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
          nodes?: ThreadNode[];
        };
      } | null;
    } | null;
  };
}

function toThread(node: ThreadNode): ReviewThread {
  if (typeof node.id !== 'string' || typeof node.isResolved !== 'boolean')
    throw new ReviewThreadsError(
      'GitHub returned a review thread without an id or resolved state.',
    );
  const first = node.comments?.nodes?.[0];
  const line =
    typeof node.line === 'number'
      ? node.line
      : typeof node.originalLine === 'number'
        ? node.originalLine
        : null;
  const body = typeof first?.body === 'string' ? first.body : '';
  return {
    id: node.id,
    isResolved: node.isResolved,
    path: typeof node.path === 'string' ? node.path : null,
    line,
    author: typeof first?.author?.login === 'string' ? first.author.login : null,
    commentId: typeof first?.databaseId === 'number' ? first.databaseId : null,
    firstLine: (body.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim(),
  };
}

/**
 * Every review thread of a pull request, paged 50 at a time. `seen` counts distinct threads read
 * and `total` is GitHub's own `totalCount`; a caller that gates on threads must require them equal.
 */
export function listThreads(
  repository: string,
  pr: number,
  runner: Runner = defaultRunner,
): ThreadListing {
  const { owner, name } = parseRepository(repository);
  const byId = new Map<string, ReviewThread>();
  let total = -1;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const command = [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${threadsQuery}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
      ...(after === null ? [] : ['-f', `after=${after}`]),
    ];
    const result = runner(command);
    if (result.code !== 0)
      throw new ReviewThreadsError(
        `gh could not list review threads for ${repository}#${pr}: ${firstLineOf(result.stderr || result.stdout)}`,
      );
    let parsed: ThreadsPage;
    try {
      parsed = JSON.parse(result.stdout) as ThreadsPage;
    } catch {
      throw new ReviewThreadsError('gh returned review threads that are not JSON.');
    }
    const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
    if (
      connection === undefined ||
      !Array.isArray(connection.nodes) ||
      typeof connection.totalCount !== 'number'
    )
      throw new ReviewThreadsError(
        `${repository}#${pr} has no review thread listing (is the pull request number right?).`,
      );
    total = connection.totalCount;
    for (const node of connection.nodes) {
      const thread = toThread(node);
      byId.set(thread.id, thread);
    }
    if (connection.pageInfo?.hasNextPage !== true) {
      const threads = [...byId.values()];
      return {
        threads,
        seen: threads.length,
        total,
        unresolved: threads.filter((thread) => !thread.isResolved).length,
      };
    }
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || cursor === after)
      throw new ReviewThreadsError('GitHub reported another page without a new cursor.');
    after = cursor;
  }
  throw new ReviewThreadsError(
    `More than ${MAX_PAGES} pages of review threads; refusing to continue.`,
  );
}

function firstLineOf(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

export interface TargetReply {
  threadId: string;
  reply: string;
}

/** Parse `<threadId><TAB><reply>` lines. Blank lines are skipped; a missing reply or a repeated thread is an error. */
export function parseReplies(text: string): TargetReply[] {
  const targets: TargetReply[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') return;
    const tab = line.indexOf('\t');
    const threadId = (tab === -1 ? line : line.slice(0, tab)).trim();
    const reply =
      tab === -1
        ? ''
        : line
            .slice(tab + 1)
            .replace(/\\n/g, '\n')
            .trim();
    if (threadId === '' || reply === '')
      throw new UsageError(`Line ${index + 1} needs a thread id, a tab and a reply.`);
    if (seen.has(threadId)) throw new UsageError(`Line ${index + 1} repeats thread ${threadId}.`);
    seen.add(threadId);
    targets.push({ threadId, reply });
  });
  return targets;
}

export interface ResolveReport {
  targets: number;
  resolved: number;
  remainingUnresolved: number;
  seen: number;
  total: number;
  failures: { threadId: string; reason: string }[];
}

/** Reply to and resolve each target thread, then list again to confirm. */
export function resolveThreads(
  repository: string,
  pr: number,
  targets: TargetReply[],
  runner: Runner = defaultRunner,
): ResolveReport {
  const before = listThreads(repository, pr, runner);
  const byId = new Map(before.threads.map((thread) => [thread.id, thread]));
  const failures: { threadId: string; reason: string }[] = [];
  for (const { threadId, reply } of targets) {
    const thread = byId.get(threadId);
    if (thread === undefined) {
      failures.push({
        threadId,
        reason: 'no such review thread on this pull request',
      });
      continue;
    }
    if (thread.isResolved) continue;
    if (thread.commentId === null) {
      failures.push({
        threadId,
        reason: 'the thread has no first comment to reply to',
      });
      continue;
    }
    const posted = runner([
      'gh',
      'api',
      '-X',
      'POST',
      `repos/${repository}/pulls/${pr}/comments/${thread.commentId}/replies`,
      '-f',
      `body=${reply}`,
    ]);
    if (posted.code !== 0) {
      failures.push({
        threadId,
        reason: `reply failed: ${firstLineOf(posted.stderr || posted.stdout)}`,
      });
      continue;
    }
    const resolved = runner([
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${resolveMutation}`,
      '-f',
      `id=${threadId}`,
    ]);
    if (resolved.code !== 0)
      failures.push({
        threadId,
        reason: `resolve failed after the reply was posted: ${firstLineOf(resolved.stderr || resolved.stdout)}`,
      });
  }
  const after = listThreads(repository, pr, runner);
  const afterById = new Map(after.threads.map((thread) => [thread.id, thread]));
  const resolved = targets.filter(
    (target) => afterById.get(target.threadId)?.isResolved === true,
  ).length;
  return {
    targets: targets.length,
    resolved,
    remainingUnresolved: after.unresolved,
    seen: after.seen,
    total: after.total,
    failures,
  };
}

function renderThread(thread: ReviewThread): string {
  const location = thread.path === null ? '-' : `${thread.path}:${thread.line ?? '?'}`;
  const first =
    thread.firstLine.length > 100 ? `${thread.firstLine.slice(0, 99)}…` : thread.firstLine;
  return `${thread.id} ${thread.commentId ?? '-'} ${location} @${thread.author ?? 'unknown'} ${thread.isResolved ? 'resolved' : 'open'}  ${first}`;
}

export function run(
  argv: string[],
  dependencies: { runner?: Runner } = {},
): { code: number; output: string } {
  const runner = dependencies.runner ?? defaultRunner;
  const command = argv[0];
  if (command === undefined) throw new UsageError('Name a command: list or resolve.');
  if (command !== 'list' && command !== 'resolve')
    throw new UsageError(`Unknown command ${command}.`);
  const parsed = parseOptions(argv.slice(1), {
    values: command === 'resolve' ? ['file'] : [],
    flags: command === 'list' ? ['unresolved', 'json'] : ['json'],
  });
  if (parsed.positionals.length !== 2) throw new UsageError(`${command} takes <owner/repo> <pr>.`);
  const repository = parsed.positionals[0] as string;
  parseRepository(repository);
  const pr = parsePullRequest(parsed.positionals[1] as string);
  const json = parsed.flags.has('json');
  try {
    if (command === 'list') {
      const listing = listThreads(repository, pr, runner);
      const shown = parsed.flags.has('unresolved')
        ? listing.threads.filter((thread) => !thread.isResolved)
        : listing.threads;
      const complete = listing.seen === listing.total;
      const summary = `SEEN=${listing.seen} TOTAL=${listing.total} UNRESOLVED=${listing.unresolved}`;
      return {
        code: complete ? 0 : 1,
        output: json
          ? JSON.stringify({
              repository,
              pr,
              seen: listing.seen,
              total: listing.total,
              unresolved: listing.unresolved,
              complete,
              threads: shown,
            })
          : [
              ...shown.map(renderThread),
              summary + (complete ? '' : '  (incomplete: SEEN differs from TOTAL)'),
            ].join('\n'),
      };
    }
    const path = parsed.values['file'];
    if (path === undefined || path === '') throw new UsageError('--file is required.');
    if (!existsSync(path)) throw new UsageError(`No such file: ${path}`);
    const targets = parseReplies(readFileSync(path, 'utf8'));
    if (targets.length === 0) throw new UsageError(`${path} names no threads.`);
    const report = resolveThreads(repository, pr, targets, runner);
    const complete = report.seen === report.total;
    const ok = report.failures.length === 0 && report.resolved === report.targets && complete;
    return {
      code: ok ? 0 : 1,
      output: json
        ? JSON.stringify({ repository, pr, ok, ...report })
        : [
            `RESOLVED ${report.resolved}/${report.targets}  remaining unresolved on the pull request: ${report.remainingUnresolved}`,
            ...(complete ? [] : [`incomplete re-list: SEEN=${report.seen} TOTAL=${report.total}`]),
            ...report.failures.map((failure) => `FAILED ${failure.threadId}: ${failure.reason}`),
          ].join('\n'),
    };
  } catch (error) {
    if (!(error instanceof ReviewThreadsError)) throw error;
    return {
      code: 1,
      output: json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
    };
  }
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
