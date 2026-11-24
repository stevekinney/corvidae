import { rootScriptEnvironment } from './environment-configuration.ts';

export interface AccountingJob {
  id: number;
  runId: number;
  attempt: number;
  runner: string;
  conclusion: string;
  seconds: number | null;
  durationUnavailable?: string | null;
}

export function remoteMatchesRepository(remote: string, repository: string): boolean {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      remote,
    );
  return match !== null && match[1]!.toLowerCase() === repository.toLowerCase();
}

/** Provider labels are untrusted; report only recognized runner classes. */
export function classifyRunner(labels: readonly string[]): string {
  if (labels.includes('self-hosted')) return 'self-hosted';
  for (const runner of [
    'ubuntu-latest',
    'ubuntu-24.04',
    'ubuntu-24.04-arm',
    'ubuntu-22.04',
    'windows-latest',
    'windows-2022',
    'windows-2025',
    'macos-latest',
    'macos-14',
    'macos-15',
  ])
    if (labels.includes(runner)) return runner;
  return 'unknown';
}

export function jobDuration(
  start: unknown,
  end: unknown,
  conclusion: string,
): {
  seconds: number | null;
  durationUnavailable: string | null;
} {
  if (conclusion === 'skipped') return { seconds: null, durationUnavailable: 'job skipped' };
  if (typeof start !== 'string' || typeof end !== 'string')
    return { seconds: null, durationUnavailable: 'provider start or completion unavailable' };
  const started = Date.parse(start);
  const completed = Date.parse(end);
  if (!Number.isFinite(started) || !Number.isFinite(completed))
    return { seconds: null, durationUnavailable: 'provider timestamp invalid' };
  if (completed < started)
    return { seconds: null, durationUnavailable: 'provider completion precedes start' };
  return { seconds: (completed - started) / 1000, durationUnavailable: null };
}

export interface AccountingRun {
  id: number;
  attempt: number;
  event: string;
  conclusion: string | null;
  status?: string;
  superseded: boolean | null;
}

export function validAttemptOutcome(status: string, conclusion: string | null): boolean {
  return (
    ['completed', 'queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(status) &&
    (status === 'completed') === (conclusion !== null)
  );
}

/** A truncated provider list can be completed only by an independently matching local graph. */
export function verifyRecoveredCommits(
  observed: readonly string[],
  expected: number,
  recovered: readonly string[],
  landedParents: readonly string[],
  head: string,
): string[] {
  const commits = new Set(recovered);
  if (
    landedParents.length !== 1 ||
    commits.size !== recovered.length ||
    commits.size !== expected ||
    !commits.has(head) ||
    observed.some((sha) => !commits.has(sha))
  )
    throw new Error('local commit recovery did not reconcile with provider evidence');
  return [...recovered];
}

/** A direct provider PR association takes precedence; shared SHA matches remain uncharged. */
export function attributeRuns(
  revisions: readonly {
    landed: string;
    head: string;
    heads?: readonly string[];
    number?: number;
  }[],
  runs: readonly { id: number; head: string; pullRequests: readonly number[] }[],
) {
  const bySha = new Map<string, Set<string>>();
  const byPull = new Map<number, string>();
  const joined: Record<string, number[]> = Object.create(null);
  for (const revision of revisions) {
    if (Object.hasOwn(joined, revision.landed)) throw new Error('duplicate landed revision');
    joined[revision.landed] = [];
    if (revision.number !== undefined) {
      if (byPull.has(revision.number)) throw new Error('duplicate pull request');
      byPull.set(revision.number, revision.landed);
    }
    for (const sha of [revision.landed, revision.head, ...(revision.heads ?? [])]) {
      const owners = bySha.get(sha) ?? new Set<string>();
      owners.add(revision.landed);
      bySha.set(sha, owners);
    }
  }
  const ambiguous: number[] = [];
  const unmatched: number[] = [];
  const records: {
    runId: number;
    head: string;
    method: string;
    pullRequests: number[];
    landed: string | null;
    status: string;
  }[] = [];
  const seen = new Set<number>();
  for (const run of runs) {
    if (seen.has(run.id)) throw new Error(`duplicate run ${run.id}`);
    seen.add(run.id);
    const associations = [...new Set(run.pullRequests)];
    const owners =
      associations.length > 0
        ? new Set(
            associations.flatMap((number) => (byPull.has(number) ? [byPull.get(number)!] : [])),
          )
        : (bySha.get(run.head) ?? new Set<string>());
    const status =
      owners.size > 1 || (associations.length > 1 && owners.size > 0)
        ? 'ambiguous'
        : owners.size === 1
          ? 'attributed'
          : 'unmatched';
    const landed = status === 'attributed' ? [...owners][0]! : null;
    if (status === 'ambiguous') ambiguous.push(run.id);
    else if (landed !== null) joined[landed]!.push(run.id);
    else unmatched.push(run.id);
    records.push({
      runId: run.id,
      head: run.head,
      method: associations.length > 0 ? 'provider-pr' : 'commit-sha',
      pullRequests: associations,
      landed,
      status,
    });
  }
  return { joined, ambiguous, unmatched, records };
}

/** A captured provider answer is reused verbatim; a broken capture never triggers a refetch. */
export async function immutableSnapshot(
  key: string,
  storage: { read(key: string): string | undefined; write(key: string, value: string): unknown },
  fetch: () => Promise<string>,
): Promise<unknown> {
  const read = storage.read.bind(storage);
  const write = storage.write.bind(storage);
  const stored = read(key);
  const raw = stored ?? (await fetch());
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid snapshot ${key}`);
  }
  if (stored === undefined) write(key, raw);
  return value;
}

/** Reject partial or changing provider inventories instead of reporting a smaller denominator. */
export async function collectPages<T>(
  readPage: (page: number) => Promise<{ total: number; items: readonly T[] }>,
): Promise<T[]> {
  const items: T[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await readPage(page);
    if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items))
      throw new Error('invalid provider page');
    expected ??= result.total;
    if (expected !== result.total || items.length + result.items.length > expected)
      throw new Error('inconsistent provider inventory');
    items.push(...result.items);
    if (items.length === expected) return items;
    if (result.items.length === 0) throw new Error('incomplete provider inventory');
  }
  throw new Error('incomplete provider inventory: page limit exceeded');
}

/** Nearest-rank percentiles are calculated over observed values only. */
export function summarizeDurations(durations: readonly (number | null)[]) {
  const observed = durations.filter((value): value is number => value !== null);
  if (observed.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('invalid duration');
  observed.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    observed[Math.ceil(observed.length * fraction) - 1] ?? null;
  return {
    observed: observed.length,
    missing: durations.length - observed.length,
    p50Seconds: percentile(0.5),
    p95Seconds: percentile(0.95),
    billedUnits: null,
    rate: null,
    cost: null,
  };
}

/** A canceled attempt cannot satisfy delivery, regardless of subsequent attempts. */
export function accountRuns(runs: readonly AccountingRun[]) {
  const events: Record<string, number> = Object.create(null);
  const seen = new Set<string>();
  let successfulFirstAttempts = 0;
  let retries = 0;
  let cancelled = 0;
  let superseded = 0;
  let supersessionUnknown = 0;
  let pending = 0;
  let queued = 0;
  let inProgress = 0;
  let nonSupersededSuccessfulAttempts = 0;
  for (const run of runs) {
    const identity = `${run.id}:${run.attempt}`;
    if (seen.has(identity)) throw new Error(`duplicate run attempt ${identity}`);
    seen.add(identity);
    events[run.event] = (events[run.event] ?? 0) + 1;
    if (run.attempt > 1) retries += 1;
    if (run.conclusion === 'cancelled') cancelled += 1;
    if (run.superseded === true) superseded += 1;
    if (run.superseded === null) supersessionUnknown += 1;
    if (run.conclusion === null) pending += 1;
    if (run.status === 'queued') queued += 1;
    if (run.status === 'in_progress') inProgress += 1;
    if (run.conclusion === 'success' && run.attempt === 1) successfulFirstAttempts += 1;
    if (run.conclusion === 'success' && run.superseded === false)
      nonSupersededSuccessfulAttempts += 1;
  }
  return {
    attempts: runs.length,
    successfulFirstAttempts,
    retries,
    cancelled,
    superseded,
    supersessionUnknown,
    pending,
    queued,
    inProgress,
    nonSupersededSuccessfulAttempts,
    events,
  };
}

/** Count immutable provider job IDs once, and refuse inconsistent copies. */
export function uniqueJobs(jobs: readonly AccountingJob[]): AccountingJob[] {
  const unique = new Map<number, AccountingJob>();
  for (const job of jobs) {
    if (
      ![job.id, job.runId, job.attempt].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      (job.seconds !== null && (!Number.isFinite(job.seconds) || job.seconds < 0))
    )
      throw new Error('invalid job identity or duration');
    const previous = unique.get(job.id);
    if (previous !== undefined) {
      if (
        previous.runId !== job.runId ||
        previous.attempt !== job.attempt ||
        previous.runner !== job.runner ||
        previous.conclusion !== job.conclusion ||
        previous.seconds !== job.seconds ||
        previous.durationUnavailable !== job.durationUnavailable
      )
        throw new Error(`conflicting job ${job.id}`);
      continue;
    }
    unique.set(job.id, job);
  }
  return [...unique.values()];
}

/** Aggregate only revisions whose selected runs all have observable job durations. */
export function revisionDurations(
  revisions: Readonly<Record<string, readonly number[]>>,
  jobs: readonly AccountingJob[],
  attempts: readonly AccountingRun[],
): Record<string, number | null> {
  const byRun = new Map<number, AccountingJob[]>();
  for (const job of uniqueJobs(jobs)) {
    const list = byRun.get(job.runId) ?? [];
    list.push(job);
    byRun.set(job.runId, list);
  }
  const result: Record<string, number | null> = Object.create(null);
  for (const [revision, runs] of Object.entries(revisions)) {
    let total = 0;
    let complete = runs.length > 0;
    for (const run of runs) {
      const entries = byRun.get(run);
      if (entries === undefined) {
        complete = false;
        continue;
      }
      const runAttempts = attempts.filter((attempt) => attempt.id === run);
      if (
        runAttempts.length === 0 ||
        runAttempts.some((attempt) => !entries.some((job) => job.attempt === attempt.attempt))
      )
        complete = false;
      for (const job of entries) {
        if (job.seconds !== null) total += job.seconds;
        else if (job.conclusion !== 'skipped') complete = false;
      }
    }
    result[revision] = complete ? total : null;
  }
  return result;
}

export function accountJobs(
  jobs: readonly AccountingJob[],
): Record<string, { jobs: number; measuredJobs: number; executionSeconds: number }> {
  const totals: Record<string, { jobs: number; measuredJobs: number; executionSeconds: number }> =
    Object.create(null);
  for (const job of uniqueJobs(jobs)) {
    const total = (totals[job.runner] ??= { jobs: 0, measuredJobs: 0, executionSeconds: 0 });
    total.jobs += 1;
    if (job.seconds !== null) {
      total.measuredJobs += 1;
      total.executionSeconds += job.seconds;
    }
  }
  return totals;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const repository = option('--repo');
  const from = option('--from');
  const until = option('--until');
  const directory = rootScriptEnvironment()['CI_ACCOUNTING_EVIDENCE_DIRECTORY'];
  if (!repository || !from || !until || !directory || !args.includes('--json')) {
    process.stderr.write(
      'Usage: CI_ACCOUNTING_EVIDENCE_DIRECTORY=<directory> bun scripts/ci-run-accounting.ts --repo <owner/repo> --from <UTC> --until <UTC> --json\n',
    );
    process.exit(2);
  }
  try {
    const { collectAccounting } = await import('./ci-run-accounting-collection.ts');
    const result = await collectAccounting(repository, from, until, directory, {
      selectionOnly: rootScriptEnvironment()['CI_ACCOUNTING_SELECTION_ONLY'] === '1',
      planOnly: rootScriptEnvironment()['CI_ACCOUNTING_PLAN_ONLY'] === '1',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ('commitInventoryComplete' in result && !result.commitInventoryComplete)
      process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'accounting failed'}\n`);
    process.exitCode = 1;
  }
}
