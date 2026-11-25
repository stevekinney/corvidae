import { describe, expect, test } from 'bun:test';

import { throwingRejectionOf } from '../testing/testing/src/helpers/promise-outcome.ts';

import { collectAccounting, pullCommitHeads } from './ci-run-accounting-collection.ts';
import { providerPages } from './ci-run-accounting-provider.ts';
import {
  accountJobs,
  accountRuns,
  attributeRuns,
  classifyRunner,
  collectPages,
  immutableSnapshot,
  jobDuration,
  remoteMatchesRepository,
  revisionDurations,
  summarizeDurations,
  validAttemptOutcome,
  verifyRecoveredCommits,
} from './ci-run-accounting.ts';

describe('CI job accounting', () => {
  test('counts each provider job once across attempts and excludes unstarted jobs', () => {
    const jobs = [
      { id: 1, runId: 10, attempt: 1, runner: 'linux', conclusion: 'failure', seconds: 61 },
      { id: 1, runId: 10, attempt: 1, runner: 'linux', conclusion: 'failure', seconds: 61 },
      { id: 2, runId: 10, attempt: 2, runner: 'linux', conclusion: 'success', seconds: 50 },
      { id: 3, runId: 11, attempt: 1, runner: 'arm', conclusion: 'cancelled', seconds: null },
      { id: 4, runId: 12, attempt: 1, runner: 'arm', conclusion: 'skipped', seconds: null },
    ];
    expect(accountJobs(jobs)).toEqual({
      linux: { jobs: 2, measuredJobs: 2, executionSeconds: 111 },
      arm: { jobs: 2, measuredJobs: 0, executionSeconds: 0 },
    });
  });

  test('rejects conflicting duplicate job identities', () => {
    expect(() =>
      accountJobs([
        { id: 1, runId: 10, attempt: 1, runner: 'linux', conclusion: 'failure', seconds: 1 },
        { id: 1, runId: 10, attempt: 2, runner: 'linux', conclusion: 'success', seconds: 2 },
      ]),
    ).toThrow('conflicting job');
  });

  test('rejects invalid job identities and durations at the accounting boundary', () => {
    const job = {
      id: 1,
      runId: 10,
      attempt: 1,
      runner: 'linux',
      conclusion: 'success',
      seconds: 10,
    };
    expect(() => accountJobs([{ ...job, id: 0 }])).toThrow('invalid job');
    expect(() => accountJobs([{ ...job, seconds: -1 }])).toThrow('invalid job');
    expect(() => accountJobs([{ ...job, seconds: Number.NaN }])).toThrow('invalid job');
  });

  test('keeps cancellations and supersession distinct from delivery success', () => {
    expect(
      accountRuns([
        { id: 1, attempt: 1, event: 'pull_request', conclusion: 'cancelled', superseded: true },
        { id: 2, attempt: 1, event: 'pull_request', conclusion: 'success', superseded: false },
        { id: 2, attempt: 2, event: 'pull_request', conclusion: 'success', superseded: false },
        {
          id: 3,
          attempt: 1,
          event: 'workflow_dispatch',
          status: 'queued',
          conclusion: null,
          superseded: null,
        },
      ]),
    ).toEqual({
      attempts: 4,
      successfulFirstAttempts: 1,
      retries: 1,
      cancelled: 1,
      superseded: 1,
      supersessionUnknown: 1,
      pending: 1,
      queued: 1,
      inProgress: 0,
      nonSupersededSuccessfulAttempts: 2,
      events: { pull_request: 3, workflow_dispatch: 1 },
    });
  });

  test('reports observed elapsed time without inventing billed units or rates', () => {
    expect(summarizeDurations([60, 10, 20, null])).toEqual({
      observed: 3,
      missing: 1,
      p50Seconds: 20,
      p95Seconds: 60,
      billedUnits: null,
      rate: null,
      cost: null,
    });
    expect(summarizeDurations([null]).p50Seconds).toBeNull();
    expect(() => summarizeDurations([-1])).toThrow('invalid duration');
  });

  test('reports per-revision durations without hiding unobserved jobs', () => {
    const jobs = [
      { id: 1, runId: 10, attempt: 1, runner: 'linux', conclusion: 'success', seconds: 60 },
      { id: 2, runId: 10, attempt: 1, runner: 'linux', conclusion: 'skipped', seconds: null },
      { id: 3, runId: 11, attempt: 1, runner: 'arm', conclusion: 'cancelled', seconds: null },
    ];
    const attempts = [
      { id: 10, attempt: 1, event: 'pull_request', conclusion: 'success', superseded: false },
      { id: 11, attempt: 1, event: 'push', conclusion: 'cancelled', superseded: null },
    ];
    expect(revisionDurations({ a: [10], b: [11], c: [] }, jobs, attempts)).toEqual({
      a: 60,
      b: null,
      c: null,
    });
  });

  test('marks reversed provider timestamps unavailable instead of charging a negative duration', () => {
    expect(jobDuration('2026-11-16T21:30:23Z', '2026-11-16T21:30:22Z', 'cancelled')).toEqual({
      seconds: null,
      durationUnavailable: 'provider completion precedes start',
    });
  });

  test('rejects contradictory attempt status and conclusion', () => {
    expect(validAttemptOutcome('completed', 'success')).toBe(true);
    expect(validAttemptOutcome('queued', null)).toBe(true);
    expect(validAttemptOutcome('completed', null)).toBe(false);
    expect(validAttemptOutcome('queued', 'success')).toBe(false);
  });

  test('does not publish arbitrary runner labels in accounting', () => {
    expect(classifyRunner(['ubuntu-latest'])).toBe('ubuntu-latest');
    expect(classifyRunner(['self-hosted', 'private-marker'])).toBe('self-hosted');
    expect(classifyRunner(['private-marker'])).toBe('unknown');
  });

  test('rejects a local Git history belonging to a different repository', () => {
    expect(
      remoteMatchesRepository('https://github.com/owner/repository.git', 'owner/repository'),
    ).toBe(true);
    expect(remoteMatchesRepository('git@github.com:owner/repository.git', 'owner/repository')).toBe(
      true,
    );
    expect(remoteMatchesRepository('https://github.com/owner/other.git', 'owner/repository')).toBe(
      false,
    );
    expect(
      remoteMatchesRepository('https://secret@github.com/owner/repository.git', 'owner/repository'),
    ).toBe(false);
  });

  test('fails closed if a provider page is missing or changes its total', async () => {
    expect(await collectPages(async (page) => ({ total: 2, items: [page] }))).toEqual([1, 2]);
    expect(await throwingRejectionOf(collectPages(async () => ({ total: 2, items: [] })))).toThrow(
      'incomplete',
    );
    expect(
      await throwingRejectionOf(
        collectPages(async (page) => ({ total: page === 1 ? 2 : 3, items: [page] })),
      ),
    ).toThrow('inconsistent');
  });

  test('reuses an immutable provider snapshot without refetching', async () => {
    const snapshots = new Map<string, string>();
    let calls = 0;
    const storage = {
      read: (key: string) => snapshots.get(key),
      write: (key: string, value: string) => snapshots.set(key, value),
    };
    const fetch = async () => {
      calls += 1;
      return '{"id":1}';
    };
    expect(await immutableSnapshot('run-1-attempt-1', storage, fetch)).toEqual({ id: 1 });
    expect(await immutableSnapshot('run-1-attempt-1', storage, fetch)).toEqual({ id: 1 });
    expect(calls).toBe(1);
    snapshots.set('bad', 'not json');
    expect(await throwingRejectionOf(immutableSnapshot('bad', storage, fetch))).toThrow(
      'invalid snapshot',
    );
  });

  test('snapshots the storage writer before awaiting the provider', async () => {
    const writes: string[] = [];
    let finish: ((value: string) => void) | undefined;
    const storage = {
      read: () => undefined,
      write: (_key: string, value: string) => writes.push(value),
    };
    const pending = immutableSnapshot(
      'run',
      storage,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    storage.write = () => {
      throw new Error('replaced writer');
    };
    finish!('{"id":1}');
    expect(await pending).toEqual({ id: 1 });
    expect(writes).toEqual(['{"id":1}']);
  });

  // spawn-free: the injected client, remote, main and writer replace process and file operations
  test('snapshots collection options before awaiting the selection writer', async () => {
    const dependencies = {
      client: {
        get: async () => ({ total_count: 0, workflow_runs: [] }),
        graphql: async () => ({}),
        calls: () => 0,
      },
      remoteUrl: 'https://github.com/owner/repository.git',
      mainRevision: 'a'.repeat(40),
      selectionOnly: true,
      writeSelection: async () => {
        dependencies.selectionOnly = false;
      },
    };
    const result = await collectAccounting(
      'owner/repository',
      '2026-11-01T00:00:00Z',
      '2026-11-02T00:00:00Z',
      'unused',
      dependencies,
    );
    expect('revisions' in result).toBe(false);
  });

  test('joins head and landed identities without charging ambiguous work twice', () => {
    const revisions = [
      { landed: 'merge-a', head: 'head-a' },
      { landed: 'merge-b', head: 'head-b' },
    ];
    const result = attributeRuns(revisions, [
      { id: 1, head: 'head-a', pullRequests: [] },
      { id: 2, head: 'merge-a', pullRequests: [] },
      { id: 3, head: 'head-b', pullRequests: [] },
      { id: 4, head: 'unmatched', pullRequests: [] },
    ]);
    expect(result.joined).toEqual({ 'merge-a': [1, 2], 'merge-b': [3] });
    expect(result.unmatched).toEqual([4]);
    expect(result.records[0]?.method).toBe('commit-sha');
  });

  test('prefers direct PR associations and leaves shared or unrelated work unattributed', () => {
    const result = attributeRuns(
      [
        { landed: 'a', head: 'head-a', heads: ['shared'], number: 1 },
        { landed: 'b', head: 'head-b', heads: ['shared'], number: 2 },
      ],
      [
        { id: 1, head: 'shared', pullRequests: [1] },
        { id: 2, head: 'shared', pullRequests: [] },
        { id: 3, head: 'head-a', pullRequests: [99] },
        { id: 4, head: 'head-b', pullRequests: [] },
      ],
    );
    expect(result.joined).toEqual({ a: [1], b: [4] });
    expect(result.ambiguous).toEqual([2]);
    expect(result.unmatched).toEqual([3]);
    expect(result.records[0]?.method).toBe('provider-pr');
  });

  test('reconciles retries, duplicate jobs, cancellation and supersession in one fixture', () => {
    const attempts = [
      { id: 10, attempt: 1, event: 'pull_request', conclusion: 'failure', superseded: true },
      { id: 10, attempt: 2, event: 'pull_request', conclusion: 'success', superseded: false },
      { id: 11, attempt: 1, event: 'push', conclusion: 'cancelled', superseded: true },
    ];
    const first = {
      id: 101,
      runId: 10,
      attempt: 1,
      runner: 'linux',
      conclusion: 'failure',
      seconds: 60,
    };
    const jobs = [
      first,
      first,
      { id: 102, runId: 10, attempt: 2, runner: 'linux', conclusion: 'success', seconds: 90 },
      { id: 103, runId: 11, attempt: 1, runner: 'arm', conclusion: 'cancelled', seconds: 10 },
    ];
    expect(accountJobs(jobs)).toEqual({
      linux: { jobs: 2, measuredJobs: 2, executionSeconds: 150 },
      arm: { jobs: 1, measuredJobs: 1, executionSeconds: 10 },
    });
    const totals = accountRuns(attempts);
    expect(totals.retries).toBe(1);
    expect(totals.cancelled).toBe(1);
    expect(totals.superseded).toBe(2);
    expect(totals.nonSupersededSuccessfulAttempts).toBe(1);
  });

  test('accepts local PR commit recovery only with one parent, matching count and provider subset', () => {
    expect(verifyRecoveredCommits(['a', 'b'], 3, ['a', 'b', 'c'], ['parent'], 'c')).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(() =>
      verifyRecoveredCommits(['a', 'missing'], 3, ['a', 'b', 'c'], ['parent'], 'c'),
    ).toThrow();
    expect(() => verifyRecoveredCommits(['a'], 3, ['a', 'b', 'c'], ['one', 'two'], 'c')).toThrow();
    expect(() => verifyRecoveredCommits(['a'], 4, ['a', 'b', 'c'], ['parent'], 'c')).toThrow();
  });

  test('rejects the provider search ceiling rather than accepting a truncated page', async () => {
    expect(
      await throwingRejectionOf(
        providerPages(
          async () => ({ total_count: 1001, workflow_runs: [] }),
          'runs',
          'workflow_runs',
        ),
      ),
    ).toThrow('search limit');
  });

  // spawn-free: the injected provider client returns only in-memory objects
  test('refuses duplicate provider commits even when the page count matches', async () => {
    const sha = 'a'.repeat(40);
    const client = { get: async () => ({}), graphql: async () => ({}), calls: () => 0 };
    expect(
      await throwingRejectionOf(
        pullCommitHeads(client, 'owner/repository', 1, {
          totalCount: 2,
          pageInfo: { hasNextPage: false },
          nodes: [{ commit: { oid: sha } }, { commit: { oid: sha } }],
        }),
      ),
    ).toThrow('duplicate pull request');
  });

  // spawn-free: injected client, remote, main, history, ancestry, recovery and writer avoid processes
  test('collects a fixed cohort and snapshots the selection before job details', async () => {
    const head = 'a'.repeat(40);
    const landed = 'b'.repeat(40);
    let selected = false;
    const get = async (endpoint: string): Promise<Record<string, unknown>> => {
      if (endpoint.includes('/actions/runs?'))
        return {
          total_count: 1,
          workflow_runs: [
            {
              id: 10,
              path: '.github/workflows/pull-request.yml',
              event: 'pull_request',
              head_sha: head,
              run_attempt: 2,
              pull_requests: [],
              created_at: '2026-11-01T12:00:00Z',
            },
          ],
        };
      if (!selected) throw new Error('selection was not persisted first');
      if (endpoint.includes('/jobs?')) {
        const attempt = endpoint.includes('/attempts/1/') ? 1 : 2;
        return {
          total_count: 1,
          jobs: [
            {
              id: attempt,
              run_id: 10,
              run_attempt: attempt,
              conclusion: attempt === 1 ? 'failure' : 'success',
              labels: ['ubuntu-latest'],
              started_at: '2026-11-01T12:00:00Z',
              completed_at: '2026-11-01T12:01:00Z',
            },
          ],
        };
      }
      if (endpoint.includes('/attempts/'))
        return {
          id: 10,
          run_attempt: endpoint.endsWith('/1') ? 1 : 2,
          head_sha: head,
          status: 'completed',
          event: 'pull_request',
          conclusion: endpoint.endsWith('/1') ? 'failure' : 'success',
        };
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    const result = await collectAccounting(
      'owner/repository',
      '2026-11-01T00:00:00Z',
      '2026-11-02T00:00:00Z',
      'unused',
      {
        client: {
          get,
          calls: () => 0,
          graphql: async () => ({
            data: {
              search: {
                issueCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    mergedAt: '2026-11-01T13:00:00Z',
                    number: 1,
                    mergeCommit: { oid: landed },
                    headRefOid: head,
                    commits: {
                      totalCount: 2,
                      pageInfo: { hasNextPage: false },
                      nodes: [{ commit: { oid: head } }],
                    },
                  },
                ],
              },
            },
          }),
        },
        history: '',
        mainRevision: landed,
        remoteUrl: 'https://github.com/owner/repository.git',
        isAncestor: (sha) => sha === landed,
        recoverCommits: () => ({ parents: ['c'.repeat(40)], commits: [head, 'd'.repeat(40)] }),
        writeSelection: async () => {
          selected = true;
        },
      },
    );
    if (!('jobs' in result) || !result.jobs || !result.joined || !result.attempts)
      throw new Error('accounting was not collected');
    expect(result.joined[landed]).toEqual([10]);
    expect(result.attempts.retries).toBe(1);
    expect(result.recoveredCommitInventories).toEqual([
      { number: 1, parent: 'c'.repeat(40), expected: 2, observed: 1 },
    ]);
    expect(result.jobs['ubuntu-latest']?.executionSeconds).toBe(120);
    expect(result.costSubtotal).toBeNull();
    expect(result.commitInventoryComplete).toBe(true);
  });
});
