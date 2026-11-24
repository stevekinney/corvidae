import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { provider, providerPages } from './ci-run-accounting-provider.ts';
import {
  accountJobs,
  accountRuns,
  attributeRuns,
  classifyRunner,
  jobDuration,
  remoteMatchesRepository,
  revisionDurations,
  summarizeDurations,
  uniqueJobs,
  validAttemptOutcome,
  verifyRecoveredCommits,
  type AccountingJob,
  type AccountingRun,
} from './ci-run-accounting.ts';

type JsonObject = Record<string, unknown>;
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const conclusions = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'neutral',
  'stale',
  'startup_failure',
]);

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`invalid ${label}`);
  return value;
}

function conclusion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !conclusions.has(value))
    throw new Error('invalid provider conclusion');
  return value;
}

function timestamp(value: unknown, label: string): number {
  const text = string(value, label);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`invalid ${label}`);
  return time;
}

function record(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid provider object');
  return value as JsonObject;
}

export async function pullCommitHeads(
  client: ReturnType<typeof provider>,
  repository: string,
  pullNumber: number,
  initial: JsonObject,
): Promise<{ heads: string[]; expected: number; complete: boolean }> {
  const graphql = client.graphql.bind(client);
  const [owner, name] = repository.split('/');
  const query = `query($cursor:String){repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${pullNumber}){commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid}}}}}}`;
  const heads: string[] = [];
  const seen = new Set<string>();
  let current = initial;
  let expected: number | undefined;
  let cursor: string | null = null;
  for (;;) {
    const total = current['totalCount'];
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Array.isArray(current['nodes'])
    )
      throw new Error(`invalid pull request ${pullNumber} commit inventory`);
    expected ??= total;
    if (total !== expected || heads.length + current['nodes'].length > total)
      throw new Error(`inconsistent pull request ${pullNumber} commit inventory`);
    for (const node of current['nodes']) {
      const sha = string(record(record(node)['commit'])['oid'], 'pull request commit');
      if (!shaPattern.test(sha)) throw new Error('invalid pull request commit');
      if (seen.has(sha)) throw new Error(`duplicate pull request ${pullNumber} commit`);
      seen.add(sha);
      heads.push(sha);
    }
    const page = record(current['pageInfo']);
    if (page['hasNextPage'] === false) {
      return { heads, expected, complete: heads.length === expected };
    }
    const next = string(page['endCursor'], 'pull request commit cursor');
    if (page['hasNextPage'] !== true || next === cursor || current['nodes'].length === 0)
      throw new Error(`invalid pull request ${pullNumber} commit pagination`);
    cursor = next;
    const response = await graphql(query, '', cursor);
    current = record(
      record(record(record(response['data'])['repository'])['pullRequest'])['commits'],
    );
  }
}

/** Collect a fixed window, snapshotting selection before requesting any job details. */
export async function collectAccounting(
  repository: string,
  from: string,
  until: string,
  directory: string,
  dependencies: {
    client?: ReturnType<typeof provider>;
    history?: string;
    isAncestor?: (sha: string) => boolean;
    recoverCommits?: (landed: string, head: string) => { parents: string[]; commits: string[] };
    mainRevision?: string;
    remoteUrl?: string;
    writeSelection?: (selection: unknown) => Promise<void>;
    selectionOnly?: boolean;
    planOnly?: boolean;
  } = {},
) {
  const options = { ...dependencies };
  if (!repositoryPattern.test(repository)) throw new Error('invalid repository');
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(from) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(until)
  )
    throw new Error('window must use UTC timestamps');
  const start = timestamp(from, 'window start');
  const end = timestamp(until, 'window end');
  if (start >= end) throw new Error('window must be nonempty');
  const sourceClient = options.client ?? provider(directory);
  const client = {
    get: sourceClient.get.bind(sourceClient),
    graphql: sourceClient.graphql.bind(sourceClient),
    calls: sourceClient.calls.bind(sourceClient),
  };
  const remoteUrl =
    options.remoteUrl ??
    execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (!remoteMatchesRepository(remoteUrl, repository))
    throw new Error('local origin does not match requested repository');
  const pinnedMain = process.env['CI_ACCOUNTING_MAIN_SHA'];
  if (pinnedMain !== undefined && !shaPattern.test(pinnedMain))
    throw new Error('invalid pinned main revision');
  const mainRevision =
    options.mainRevision ??
    execFileSync('git', ['rev-parse', '--verify', `${pinnedMain ?? 'origin/main'}^{commit}`], {
      encoding: 'utf8',
    }).trim();
  if (!shaPattern.test(mainRevision)) throw new Error('invalid main revision');
  const prefix = `repos/${repository}`;
  const allRuns: JsonObject[] = [];
  for (let day = Math.floor(start / 86_400_000) * 86_400_000; day < end; day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    allRuns.push(
      ...(await providerPages(
        (endpoint) => client.get(endpoint),
        `${prefix}/actions/runs?created=${date}`,
        'workflow_runs',
      )),
    );
  }
  const windowRuns = allRuns.filter((run) => {
    const created = timestamp(run['created_at'], 'run creation');
    return created >= start && created < end;
  });
  const workflowPaths = new Set([
    '.github/workflows/main.yml',
    '.github/workflows/pull-request.yml',
    '.github/workflows/targeted-checks.yml',
  ]);
  const selected = windowRuns.filter(
    (run) => typeof run['path'] === 'string' && workflowPaths.has(run['path']),
  );
  const selection = {
    repository,
    from,
    until,
    boundary: '[from, until)',
    observedWorkflowRuns: windowRuns.length,
    selectedWorkflowRuns: selected.length,
    selected: selected.map((run) => {
      const head = string(run['head_sha'], 'run head');
      const event = string(run['event'], 'run event');
      if (
        !shaPattern.test(head) ||
        !['push', 'pull_request', 'workflow_dispatch', 'schedule'].includes(event)
      )
        throw new Error('invalid provider run identity');
      return {
        id: number(run['id'], 'run id'),
        path: run['path'],
        event,
        head,
        attempt: number(run['run_attempt'], 'run attempt'),
      };
    }),
  };
  const selectionPath = join(directory, 'selection.json');
  if (options.writeSelection !== undefined)
    await options.writeSelection(structuredClone(selection));
  else {
    try {
      writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await Bun.file(selectionPath).text();
      if (existing !== `${JSON.stringify(selection, null, 2)}\n`)
        throw new Error('selection snapshot differs', { cause: error });
    }
  }
  if (options.selectionOnly === true) return { selection, providerCalls: client.calls() };

  const pullRequests: { landed: string; head: string; heads: string[]; number: number }[] = [];
  const incompleteCommitInventories: { number: number; expected: number; observed: number }[] = [];
  const recoveredCommitInventories: {
    number: number;
    parent: string;
    expected: number;
    observed: number;
  }[] = [];
  const search = `repo:${repository} is:pr is:merged base:main merged:${from.slice(0, 10)}..${until.slice(0, 10)}`;
  const query =
    'query($search:String!,$cursor:String){search(query:$search,type:ISSUE,first:100,after:$cursor){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number headRefOid mergedAt mergeCommit{oid} commits(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid}}}}}}}';
  let cursor: string | null = null;
  let expected: number | undefined;
  let collected = 0;
  const seenPullRequests = new Set<number>();
  for (;;) {
    const response = await client.graphql(query, search, cursor);
    const result = record(record(response['data'])['search']);
    const count = result['issueCount'];
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 1000 ||
      !Array.isArray(result['nodes'])
    )
      throw new Error('invalid or truncated pull request search');
    expected ??= count;
    if (expected !== count || collected + result['nodes'].length > count)
      throw new Error('inconsistent pull request search');
    collected += result['nodes'].length;
    for (const node of result['nodes']) {
      const pull = record(node);
      const pullNumber = number(pull['number'], 'pull request number');
      if (seenPullRequests.has(pullNumber)) throw new Error('duplicate pull request search result');
      seenPullRequests.add(pullNumber);
      const merged = timestamp(pull['mergedAt'], 'merge time');
      if (merged < start || merged >= end) continue;
      const landed = string(record(pull['mergeCommit'])['oid'], 'landed commit');
      const head = string(pull['headRefOid'], 'pull request head');
      if (!shaPattern.test(landed) || !shaPattern.test(head))
        throw new Error('invalid pull request identity');
      const commits = await pullCommitHeads(
        client,
        repository,
        pullNumber,
        record(pull['commits']),
      );
      let heads = commits.heads;
      if (commits.complete && !heads.includes(head))
        throw new Error(
          `pull request ${pullNumber} head missing from its complete commit inventory`,
        );
      if (!commits.complete) {
        try {
          const recover =
            options.recoverCommits ??
            ((landing: string, revision: string) => {
              const parents = execFileSync('git', ['show', '-s', '--format=%P', landing], {
                encoding: 'utf8',
              })
                .trim()
                .split(' ')
                .filter(Boolean);
              if (parents.length !== 1) throw new Error('landing does not have one parent');
              const local = execFileSync('git', ['rev-list', revision, '--not', parents[0]!], {
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
              })
                .trim()
                .split('\n')
                .filter(Boolean);
              return { parents, commits: local };
            });
          const local = recover(landed, head);
          heads = verifyRecoveredCommits(
            commits.heads,
            commits.expected,
            local.commits,
            local.parents,
            head,
          );
          recoveredCommitInventories.push({
            number: pullNumber,
            parent: local.parents[0]!,
            expected: commits.expected,
            observed: commits.heads.length,
          });
        } catch {
          incompleteCommitInventories.push({
            number: pullNumber,
            expected: commits.expected,
            observed: commits.heads.length,
          });
        }
      }
      pullRequests.push({ landed, head, heads, number: pullNumber });
    }
    const page = record(result['pageInfo']);
    if (page['hasNextPage'] === false) {
      if (collected !== expected) throw new Error('incomplete pull request search');
      break;
    }
    const next = string(page['endCursor'], 'pull request cursor');
    if (page['hasNextPage'] !== true || next === cursor || result['nodes'].length === 0)
      throw new Error('invalid pull request pagination');
    cursor = next;
  }

  const history =
    options.history ??
    execFileSync('git', ['log', '--first-parent', '--format=%H%x09%cI', mainRevision], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  const landed = history
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [commit, date] = line.split('\t');
      if (commit === undefined || !shaPattern.test(commit)) throw new Error('invalid main history');
      const at = timestamp(date, 'commit time');
      return at >= start && at < end ? [commit] : [];
    });
  const pullByMerge = new Map(pullRequests.map((pull) => [pull.landed, pull]));
  if (pullByMerge.size !== pullRequests.length) throw new Error('duplicate pull request merge');
  const missingMerges = pullRequests.filter((pull) => !landed.includes(pull.landed));
  const isAncestor =
    options.isAncestor ??
    ((sha: string) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, mainRevision]);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    });
  if (missingMerges.some((pull) => !isAncestor(pull.landed)))
    throw new Error('merged pull request is not an ancestor of origin/main');
  const revisions = [
    ...landed.map((commit) => pullByMerge.get(commit) ?? { landed: commit, head: commit }),
    ...missingMerges,
  ];
  const runIdentities = selected.map((run) => {
    if (!Array.isArray(run['pull_requests']))
      throw new Error('provider run lacks pull request associations');
    return {
      id: number(run['id'], 'run id'),
      head: string(run['head_sha'], 'run head'),
      pullRequests: run['pull_requests'].map((entry) =>
        number(record(entry)['number'], 'associated pull request'),
      ),
    };
  });
  const attribution = attributeRuns(revisions, runIdentities);
  const joined = attribution.joined;
  const eligibleIds = new Set(Object.values(joined).flat());
  const plannedAttempts = selected
    .filter((run) => eligibleIds.has(number(run['id'], 'run id')))
    .reduce((sum, run) => sum + number(run['run_attempt'], 'run attempt'), 0);
  const plan = {
    selection,
    mainRevision,
    revisions,
    joined,
    unmatchedSelectedRuns: selected.length - eligibleIds.size,
    ambiguousRuns: attribution.ambiguous,
    unmatchedRuns: attribution.unmatched,
    attributionRecords: attribution.records,
    incompleteCommitInventories,
    commitInventoryComplete: incompleteCommitInventories.length === 0,
    recoveredCommitInventories,
    eligibleRuns: eligibleIds.size,
    plannedAttempts,
    minimumDetailCalls: plannedAttempts * 2,
    additionalPaginationCalls: 'unknown',
    providerCalls: client.calls(),
  };
  if (options.planOnly === true) return plan;
  const attempts: AccountingRun[] = [];
  const jobs: AccountingJob[] = [];
  for (const run of selected) {
    const id = number(run['id'], 'run id');
    if (!eligibleIds.has(id)) continue;
    const lastAttempt = number(run['run_attempt'], 'run attempt');
    for (let attempt = 1; attempt <= lastAttempt; attempt += 1) {
      const detail = await client.get(`${prefix}/actions/runs/${id}/attempts/${attempt}`);
      if (
        number(detail['id'], 'attempt run id') !== id ||
        number(detail['run_attempt'], 'attempt number') !== attempt ||
        detail['head_sha'] !== run['head_sha'] ||
        detail['event'] !== run['event']
      )
        throw new Error('provider attempt disagrees with selected run');
      const runConclusion = conclusion(detail['conclusion']);
      const status = string(detail['status'], 'attempt status');
      if (!validAttemptOutcome(status, runConclusion))
        throw new Error('provider attempt status and conclusion disagree');
      attempts.push({
        id,
        attempt,
        event: string(run['event'], 'event'),
        conclusion: runConclusion,
        status,
        superseded: null,
      });
      const inventory = await providerPages(
        (endpoint) => client.get(endpoint),
        `${prefix}/actions/runs/${id}/attempts/${attempt}/jobs`,
        'jobs',
      );
      for (const job of inventory) {
        if (
          number(job['run_id'], 'job run id') !== id ||
          number(job['run_attempt'], 'job attempt') !== attempt
        )
          throw new Error('provider job disagrees with run attempt');
        const jobConclusion = conclusion(job['conclusion']) ?? 'pending';
        const duration = jobDuration(job['started_at'], job['completed_at'], jobConclusion);
        const labels = Array.isArray(job['labels'])
          ? job['labels'].filter((label): label is string => typeof label === 'string')
          : [];
        jobs.push({
          id: number(job['id'], 'job id'),
          runId: id,
          attempt,
          runner: classifyRunner(labels),
          conclusion: jobConclusion,
          ...duration,
        });
      }
    }
  }
  const distinctJobs = uniqueJobs(jobs);
  const perRevision = revisionDurations(joined, distinctJobs, attempts);
  return {
    selection,
    mainRevision,
    providerCalls: client.calls(),
    revisions,
    joined,
    unmatchedSelectedRuns: selected.length - eligibleIds.size,
    ambiguousRuns: attribution.ambiguous,
    unmatchedRuns: attribution.unmatched,
    attributionRecords: attribution.records,
    incompleteCommitInventories,
    commitInventoryComplete: incompleteCommitInventories.length === 0,
    recoveredCommitInventories,
    attempts: accountRuns(attempts),
    attemptRecords: attempts,
    jobs: accountJobs(distinctJobs),
    jobRecords: distinctJobs,
    execution: summarizeDurations(distinctJobs.map((job) => job.seconds)),
    perRevisionExecutionSeconds: perRevision,
    revisionExecution: summarizeDurations(Object.values(perRevision)),
    revisionExecutionScope:
      'only directly or unambiguously attributed runs; ambiguous and unmatched work is excluded',
    queueEligibility: null,
    startLag: null,
    cachedOrFresh: null,
    storage: null,
    billedUnits: null,
    rate: null,
    humanTime: null,
    agentSpend: null,
    costSubtotal: null,
    deliveryEvidence: 'not established by accounting; canceled runs cannot satisfy delivery',
  };
}
