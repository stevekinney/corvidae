#!/usr/bin/env bun
// Chef review threads: lists a pull request's review threads and answers-and-resolves them in
// batch, through `gh`. The listing pages through every thread (50 per page) and checks that it saw
// as many threads as GitHub says exist, because a gate that read only the first page once hid a
// dozen unresolved threads. Replies are keyed by thread id, never by comment id.
//
// Usage:
//   bun scripts/chef/review-threads.ts list <owner/repo> <pr> [--unresolved] [--json]
//   bun scripts/chef/review-threads.ts list --pr <n> [--repository <owner/repo>] [--config <json>]
//                                      [--unresolved] [--json]
//   bun scripts/chef/review-threads.ts resolve <owner/repo> <pr> --file <tsv> [--json]
//   bun scripts/chef/review-threads.ts resolve --pr <n> [--repository <owner/repo>] [--config <json>]
//                                      --file <tsv> [--json]
//   bun scripts/chef/review-threads.ts classes --pr <n> [--repository <owner/repo>] [--config <json>]
//                                      [--classes <json>] [--json]
//   bun scripts/chef/review-threads.ts classes <owner/repo> <pr> [--config <json>] [--classes <json>]
//                                      [--json]
//
// Every subcommand names its pull request either positionally (`<owner/repo> <pr>`) or with `--pr
// <n>`. With `--pr`, the repository is the one positional, else `--repository`, else the
// configuration's `repository` (the checked-in `repository.json` unless `--config` names another).
// Giving the repository twice, or `--pr` with a positional pull request number, is a usage error.
//
// `list` prints one line per thread (thread id, first comment's databaseId, path:line, author,
// resolved or open, first line of the first comment) and a final `SEEN=<n> TOTAL=<n>
// UNRESOLVED=<n>`. `resolve` reads `<threadId><TAB><reply>` lines (a literal `\n` in a reply
// becomes a newline), posts each reply to its thread's first comment, resolves the thread, then
// lists again and prints `RESOLVED <n>/<n>` and what remains. A thread that is already resolved is
// counted without a second reply.
//
// `classes` pages every thread the way `list` does and tags each thread's first comment with the
// defect classes in `defect-classes.json` (case-insensitive regular expressions; a thread can carry
// several classes). A round is a burst of bot comments with no gap over 10 minutes, so each push
// that a review bot answers is one round. It prints, per class, the thread count and the rounds the
// class appeared in. A class that shows up in two or more distinct rounds survived a fix pass: the
// causal model was wrong, so stop patching instances and reassess the shared cause. The repository
// comes from `--repository`, else from the configuration's `repository`.
//
// Exit codes: 0 every thread seen (and, for `resolve`, every target resolved; for `classes`, no
// class repeats across rounds), 1 SEEN differs from TOTAL, GitHub failed, a target is still
// unresolved, or a defect class repeats across rounds, 2 invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  UsageError,
  type ParsedOptions,
  type Runner,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';

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
  /** The whole first comment. */
  body: string;
  /** When the first comment was posted (ISO 8601), or `null` when GitHub gave none. */
  createdAt: string | null;
  /** Whether the first comment's author is a bot account (`Bot` type or a `[bot]` login). */
  authorIsBot: boolean;
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
          comments(first: 1) { nodes { databaseId body createdAt author { login __typename } } }
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

/** The options every subcommand shares for naming its pull request. */
const targetOptions = ['pr', 'repository', 'config'];

/**
 * The repository and pull request a subcommand acts on: `<owner/repo> <pr>` positionally, or
 * `--pr <n>` with the repository from the one positional, `--repository`, or the configuration.
 */
export function resolveTarget(
  parsed: ParsedOptions,
  command: string,
): { repository: string; pr: number } {
  const prFlag = parsed.values['pr'];
  const flagged = prFlag !== undefined;
  const usage = `${command} takes <owner/repo> <pr>, or --pr <n> [--repository <owner/repo>].`;
  if (!flagged) {
    if (parsed.positionals.length !== 2 || parsed.values['repository'] !== undefined)
      throw new UsageError(usage);
    const repository = parsed.positionals[0] as string;
    parseRepository(repository);
    return { repository, pr: parsePullRequest(parsed.positionals[1] as string) };
  }
  if (prFlag === '') throw new UsageError('--pr is required.');
  if (parsed.positionals.length > 1) throw new UsageError(usage);
  const named = parsed.positionals[0];
  if (named !== undefined && parsed.values['repository'] !== undefined)
    throw new UsageError('Name the repository once: a positional or --repository, not both.');
  const repository =
    named ??
    parsed.values['repository'] ??
    loadRepositoryConfig(parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH).repository;
  parseRepository(repository);
  return { repository, pr: parsePullRequest(prFlag) };
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
      createdAt?: unknown;
      author?: { login?: unknown; __typename?: unknown } | null;
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
    body,
    createdAt: typeof first?.createdAt === 'string' ? first.createdAt : null,
    authorIsBot:
      first?.author?.['__typename'] === 'Bot' ||
      (typeof first?.author?.login === 'string' && /\[bot\]$/i.test(first.author.login)),
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

/** One defect class: a name, what it means, and the case-insensitive patterns that tag it. */
export interface DefectClass {
  name: string;
  description: string;
  patterns: RegExp[];
}

/** The classes `classes` tags with unless `--classes` names another file. */
export const DEFAULT_DEFECT_CLASSES_PATH = join(import.meta.dir, 'defect-classes.json');

/** A gap longer than this between two bot comments starts a new round. */
export const ROUND_GAP_MILLISECONDS = 10 * 60 * 1000;

/** Parse and validate a defect-class file; every problem is a `UsageError` naming the file. */
export function parseDefectClasses(text: string, source: string): DefectClass[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${source} is not JSON.`);
  }
  const entries = (parsed as { classes?: unknown } | null)?.classes;
  if (!Array.isArray(entries) || entries.length === 0)
    throw new UsageError(`${source} needs a non-empty "classes" array.`);
  const names = new Set<string>();
  return entries.map((entry: unknown, index) => {
    const record = (entry ?? {}) as { name?: unknown; description?: unknown; patterns?: unknown };
    if (typeof record.name !== 'string' || record.name === '')
      throw new UsageError(`${source}: class ${index + 1} needs a name.`);
    if (names.has(record.name)) throw new UsageError(`${source}: class ${record.name} repeats.`);
    const name = record.name;
    names.add(name);
    if (
      !Array.isArray(record.patterns) ||
      record.patterns.length === 0 ||
      record.patterns.some((pattern) => typeof pattern !== 'string')
    )
      throw new UsageError(`${source}: class ${record.name} needs a non-empty "patterns" array.`);
    return {
      name,
      description: typeof record.description === 'string' ? record.description : '',
      patterns: (record.patterns as string[]).map((pattern) => {
        try {
          return new RegExp(pattern, 'is');
        } catch {
          throw new UsageError(`${source}: class ${name} has an invalid pattern ${pattern}.`);
        }
      }),
    };
  });
}

/** Read the defect-class file at `path`. */
export function loadDefectClasses(path: string = DEFAULT_DEFECT_CLASSES_PATH): DefectClass[] {
  if (!existsSync(path)) throw new UsageError(`No such defect-class file: ${path}`);
  return parseDefectClasses(readFileSync(path, 'utf8'), path);
}

/** The names of the classes whose patterns match `text`, in file order. */
export function tagText(text: string, classes: DefectClass[]): string[] {
  return classes
    .filter((defectClass) => defectClass.patterns.some((pattern) => pattern.test(text)))
    .map((defectClass) => defectClass.name);
}

/**
 * Number the bot comments' rounds: sort by time, and start a new round whenever the gap to the
 * previous bot comment is over ten minutes. A thread whose first comment is not a bot's, or has no
 * readable time, belongs to no round and is absent from the result.
 */
export function assignRounds(threads: ReviewThread[]): Map<string, number> {
  const stamped = threads
    .filter((thread) => thread.authorIsBot)
    .map((thread) => ({ id: thread.id, time: Date.parse(thread.createdAt ?? '') }))
    .filter((entry) => Number.isFinite(entry.time))
    .toSorted((left, right) => left.time - right.time);
  const rounds = new Map<string, number>();
  let round = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of stamped) {
    if (entry.time - previous > ROUND_GAP_MILLISECONDS) round += 1;
    rounds.set(entry.id, round);
    previous = entry.time;
  }
  return rounds;
}

export interface ClassSummary {
  name: string;
  threads: number;
  /** The distinct rounds in which a thread of this class was opened, ascending. */
  rounds: number[];
  /** Whether the class appeared in two or more distinct rounds. */
  repeating: boolean;
}

export interface ClassesReport {
  /** How many rounds of bot comments the pull request had. */
  rounds: number;
  classes: ClassSummary[];
  /** Threads that matched no class. */
  untagged: number;
  /** Names of the classes that repeat across rounds. */
  repeating: string[];
}

/** Tag every thread's first comment, group by class, and find the classes that repeat across rounds. */
export function summarizeClasses(threads: ReviewThread[], classes: DefectClass[]): ClassesReport {
  const roundOf = assignRounds(threads);
  const tally = new Map(classes.map((defectClass) => [defectClass.name, new Set<string>()]));
  const roundsOf = new Map(classes.map((defectClass) => [defectClass.name, new Set<number>()]));
  let untagged = 0;
  for (const thread of threads) {
    const names = tagText(thread.body, classes);
    if (names.length === 0) untagged += 1;
    for (const name of names) {
      tally.get(name)?.add(thread.id);
      const round = roundOf.get(thread.id);
      if (round !== undefined) roundsOf.get(name)?.add(round);
    }
  }
  const summaries = classes.map((defectClass): ClassSummary => {
    const rounds = [...(roundsOf.get(defectClass.name) ?? [])].toSorted((a, b) => a - b);
    return {
      name: defectClass.name,
      threads: tally.get(defectClass.name)?.size ?? 0,
      rounds,
      repeating: rounds.length >= 2,
    };
  });
  return {
    rounds: new Set(roundOf.values()).size,
    classes: summaries,
    untagged,
    repeating: summaries.filter((summary) => summary.repeating).map((summary) => summary.name),
  };
}

function renderClasses(report: ClassesReport): string {
  return [
    ...report.classes.map(
      (summary) =>
        `${summary.name}: ${summary.threads} thread${summary.threads === 1 ? '' : 's'}${
          summary.rounds.length === 0
            ? ''
            : `, round${summary.rounds.length === 1 ? '' : 's'} ${summary.rounds.join(', ')}`
        }${summary.repeating ? '  REPEATING' : ''}`,
    ),
    `untagged: ${report.untagged}  rounds of bot comments: ${report.rounds}`,
    report.repeating.length === 0
      ? 'No class repeats across rounds.'
      : `Repeating across rounds: ${report.repeating.join(', ')}. Stop patching instances and reassess the shared cause.`,
  ].join('\n');
}

function renderThread(thread: ReviewThread): string {
  const location = thread.path === null ? '-' : `${thread.path}:${thread.line ?? '?'}`;
  const first =
    thread.firstLine.length > 100 ? `${thread.firstLine.slice(0, 99)}…` : thread.firstLine;
  return `${thread.id} ${thread.commentId ?? '-'} ${location} @${thread.author ?? 'unknown'} ${thread.isResolved ? 'resolved' : 'open'}  ${first}`;
}

function runClasses(
  argv: string[],
  runner: Runner,
  injected: DefectClass[] | undefined,
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: [...targetOptions, 'classes'],
    flags: ['json'],
  });
  const { repository, pr } = resolveTarget(parsed, 'classes');
  const classes = injected ?? loadDefectClasses(parsed.values['classes']);
  const json = parsed.flags.has('json');
  try {
    const listing = listThreads(repository, pr, runner);
    const complete = listing.seen === listing.total;
    const report = summarizeClasses(listing.threads, classes);
    const ok = complete && report.repeating.length === 0;
    return {
      code: ok ? 0 : 1,
      output: json
        ? JSON.stringify({
            repository,
            pr,
            seen: listing.seen,
            total: listing.total,
            complete,
            ok,
            ...report,
          })
        : [
            renderClasses(report),
            ...(complete
              ? []
              : [
                  `incomplete: SEEN=${listing.seen} TOTAL=${listing.total}; the counts above miss threads`,
                ]),
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

export function run(
  argv: string[],
  dependencies: { runner?: Runner; classes?: DefectClass[] } = {},
): { code: number; output: string } {
  const runner = dependencies.runner ?? defaultRunner;
  const command = argv[0];
  if (command === undefined) throw new UsageError('Name a command: list, resolve or classes.');
  if (command === 'classes') return runClasses(argv.slice(1), runner, dependencies.classes);
  if (command !== 'list' && command !== 'resolve')
    throw new UsageError(`Unknown command ${command}.`);
  const parsed = parseOptions(argv.slice(1), {
    values: command === 'resolve' ? [...targetOptions, 'file'] : targetOptions,
    flags: command === 'list' ? ['unresolved', 'json'] : ['json'],
  });
  const { repository, pr } = resolveTarget(parsed, command);
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
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
