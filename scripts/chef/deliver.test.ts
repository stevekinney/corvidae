import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  deliver,
  executionReportHeadings,
  executionReportProblems,
  renderDeliver,
  run,
  type DeliverOptions,
} from './deliver.ts';
import { LinearError, type LinearClient } from './linear.ts';
import type { MergeGateOptions, MergeGateReport } from './merge-gate.ts';
import { UsageError } from './process-runner.ts';
import { Refusal } from './worktree.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE_COMMIT = 'd'.repeat(40);

const sampleReport = [
  'Execution report: cor-9-widgets attempt 1',
  '',
  ...executionReportHeadings.flatMap((heading) => [`## ${heading}`, '', 'Filled in.', '']),
].join('\n');

let sandbox: string;
let options: DeliverOptions;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'deliver-'));
  const configPath = join(sandbox, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'install-command',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  writeFileSync(join(sandbox, 'comment.md'), 'Accepted.\n');
  writeFileSync(join(sandbox, 'done.md'), sampleReport);
  options = { configPath, pr: 12, worktree: sandbox, commentFile: join(sandbox, 'comment.md') };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const mergedReport = (overrides: Partial<MergeGateReport> = {}): MergeGateReport => ({
  pr: 12,
  head: HEAD,
  base: BASE,
  mergeable: 'MERGEABLE',
  threads: { seen: 1, total: 1, unresolved: 0 },
  merged: true,
  mergeCommit: MERGE_COMMIT,
  treesMatch: true,
  failedStep: null,
  detail: null,
  ...overrides,
});

/** The merge gate and the closeout steps, recording what each was asked. */
function seams(
  overrides: {
    merge?: MergeGateReport;
    refusal?: string;
    usageError?: string;
    /** The identifier whose state change Linear rejects. */
    failState?: string;
  } = {},
) {
  const record = {
    merges: [] as MergeGateOptions[],
    removals: [] as string[],
    requests: [] as string[],
    /** The identifier each comment and state change was made on, in order. */
    writes: [] as string[],
  };
  const states = new Map<string, string>();
  const comments = new Map<string, { body: string; identifier: string }>();
  const stateOf = (identifier: string) => states.get(identifier) ?? 'In Progress';
  const client: LinearClient = {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      record.requests.push(document.split(/[ (]/)[1] ?? document);
      const identifier = String(variables['id'] ?? variables['issueId']).replace(/^uuid-/, '');
      const issue = (key: string) => ({
        id: `uuid-${key}`,
        identifier: key,
        title: 'T',
        description: null,
        updatedAt: 'x',
        state: {
          id: stateOf(key) === 'Done' ? 's-done' : 's-doing',
          name: stateOf(key),
        },
        team: { id: 'team', key: 'COR', parent: null },
      });
      if (document.includes('IssueRead')) return { issue: issue(identifier) } as T;
      if (document.includes('CommentPost')) {
        const id = `c${comments.size + 1}`;
        comments.set(id, { body: String(variables['body']), identifier });
        record.writes.push(`comment ${identifier}`);
        return { commentCreate: { success: true, comment: { id } } } as T;
      }
      if (document.includes('CommentRead')) {
        const found = comments.get(String(variables['id']));
        return {
          comment: found && {
            id: variables['id'],
            body: found.body,
            issue: { identifier: found.identifier },
          },
        } as T;
      }
      if (document.includes('TeamStates'))
        return {
          workflowStates: { nodes: [{ id: 's-done', name: 'Done', team: { id: 'team' } }] },
        } as T;
      if (document.includes('IssueSetState')) {
        if (identifier === overrides.failState)
          throw new LinearError('Linear rejected the request: nope');
        states.set(identifier, 'Done');
        record.writes.push(`state ${identifier}`);
        return { issueUpdate: { success: true } } as T;
      }
      throw new LinearError(`unexpected request ${document}`);
    },
  };
  return {
    record,
    partial: {
      merge: async (mergeOptions: MergeGateOptions) => {
        record.merges.push(mergeOptions);
        return overrides.merge ?? mergedReport();
      },
      remove: (removeOptions: { name: string }) => {
        record.removals.push(removeOptions.name);
        if (overrides.refusal !== undefined) throw new Refusal(overrides.refusal);
        if (overrides.usageError !== undefined) throw new UsageError(overrides.usageError);
        return { path: '/c/alpha', branch: 'b', remoteDeleted: true };
      },
      client,
    },
  };
}

const refusal = (failedStep: string, detail: string) =>
  mergedReport({ merged: false, mergeCommit: null, failedStep, detail });

describe('deliver', () => {
  test('merges through the merge gate alone: no gate, no base merge, no install', async () => {
    const { partial, record } = seams();
    const report = await deliver(options, partial);
    expect(report).toEqual({
      pr: 12,
      merged: true,
      mergeCommit: MERGE_COMMIT,
      mergeable: 'MERGEABLE',
      mainHealthWarning: null,
      failedStep: null,
      detail: null,
      issues: [],
    });
    expect(record.merges).toHaveLength(1);
    expect(record.merges[0]).toMatchObject({ pr: 12, dryRun: false, checkMainHealth: true });
    expect(record.merges[0]).not.toHaveProperty('gateLog');
    expect(Object.keys(partial).toSorted()).toEqual(['client', 'merge', 'remove']);
  });

  test('a base that moved without a conflict is merged as it is', async () => {
    // The merge gate reads GitHub's answer; BEHIND with no conflict is not a refusal.
    const { partial, record } = seams({ merge: mergedReport({ mergeable: 'MERGEABLE' }) });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(record.merges).toHaveLength(1);
  });

  test.each([
    ['conflict', 'GitHub reports the pull request conflicts with origin/main'],
    ['head', 'the pull request head is not the head pinned at acceptance'],
    ['threads', '1 review thread(s) are unresolved.'],
    ['mergeable', 'GitHub still reports the mergeability as UNKNOWN'],
  ])('a %s refusal is reported under its step, with nothing merged', async (step, detail) => {
    const { partial, record } = seams({ merge: refusal(step, detail) });
    const report = await deliver(
      { ...options, issues: ['COR-9'], completionFiles: [join(sandbox, 'done.md')] },
      partial,
    );
    expect(report).toMatchObject({ merged: false, failedStep: step, detail });
    expect(record.merges).toHaveLength(1);
    expect(record.requests).toEqual([]);
    expect(renderDeliver(report)).toContain(`FAILED at ${step}`);
  });

  test('forwards the pinned head and the fix declaration to the merge gate', async () => {
    const { partial, record } = seams();
    await deliver({ ...options, expectedHead: HEAD, fixesMain: true }, partial);
    expect(record.merges[0]).toMatchObject({ expectedHead: HEAD, fixesMain: true });
  });

  test('a red main is a warning in the report and the text, and the merge still happens', async () => {
    const { partial } = seams({
      merge: mergedReport({ mainHealthWarning: 'main batch validate at aaaa: exit 1 (RED).' }),
    });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(report.mainHealthWarning).toContain('RED');
    expect(renderDeliver(report)).toContain('WARNING main health:');
  });

  test('no merge runner is a named failure, never a silent skip', async () => {
    const report = await deliver(options, {});
    expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
  });

  test('--usage-log and --transcript reach the merge gate; without them there is no record', async () => {
    const withRecord = seams();
    await deliver(
      { ...options, usageLog: '/tmp/usage.tsv', transcripts: ['/a.jsonl', '/b'] },
      withRecord.partial,
    );
    expect(withRecord.record.merges[0]?.usageLog).toBe('/tmp/usage.tsv');
    expect(withRecord.record.merges[0]?.transcripts).toEqual(['/a.jsonl', '/b']);
    const without = seams();
    await deliver(options, without.partial);
    expect(without.record.merges[0]).not.toHaveProperty('usageLog');
  });

  test('closes the issue with the completion comment and the Done state, read back', async () => {
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, issues: ['COR-9'], completionFiles: [join(sandbox, 'done.md')] },
      partial,
    );
    expect(report).toMatchObject({
      merged: true,
      failedStep: null,
      issues: [{ identifier: 'COR-9', state: 'Done' }],
    });
    expect(record.requests).toContain('CommentPost');
    expect(record.requests).toContain('IssueSetState');
    expect(renderDeliver(report)).toContain('issues: COR-9 Done');
  });

  test('closes several issues in order, each with its own comment and then Done', async () => {
    const { partial, record } = seams();
    const second = join(sandbox, 'second.md');
    writeFileSync(second, sampleReport.replace('cor-9-widgets', 'cor-10-gadgets'));
    const report = await deliver(
      {
        ...options,
        issues: ['COR-9', 'COR-10'],
        completionFiles: [join(sandbox, 'done.md'), second],
      },
      partial,
    );
    expect(report).toMatchObject({
      merged: true,
      failedStep: null,
      issues: [
        { identifier: 'COR-9', state: 'Done' },
        { identifier: 'COR-10', state: 'Done' },
      ],
    });
    expect(record.writes).toEqual([
      'comment COR-9',
      'state COR-9',
      'comment COR-10',
      'state COR-10',
    ]);
    expect(renderDeliver(report)).toContain('issues: COR-9 Done, COR-10 Done');
  });

  test('a failed comment names its issue exactly once', async () => {
    const { partial } = seams();
    const unread: LinearClient = {
      async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
        if (document.includes('CommentPost'))
          return { commentCreate: { success: false, comment: null } } as T;
        return partial.client.request<T>(document, variables);
      },
    };
    const report = await deliver(
      { ...options, issues: ['COR-9'], completionFiles: [join(sandbox, 'done.md')] },
      { ...partial, client: unread },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'issue', issues: [] });
    expect(report.detail).toBe('COR-9: the comment was not created.');
  });

  test('a failure on the second issue keeps the first closed and names the second', async () => {
    const { partial, record } = seams({ failState: 'COR-10' });
    const second = join(sandbox, 'second.md');
    writeFileSync(second, sampleReport);
    const report = await deliver(
      {
        ...options,
        issues: ['COR-9', 'COR-10', 'COR-11'],
        completionFiles: [join(sandbox, 'done.md'), second, second],
        removeWorktree: { provider: 'claude', name: 'alpha' },
      },
      partial,
    );
    expect(report).toMatchObject({
      merged: true,
      mergeCommit: MERGE_COMMIT,
      failedStep: 'issue',
      issues: [{ identifier: 'COR-9', state: 'Done' }],
    });
    expect(report.detail).toStartWith('COR-10:');
    expect(report.detail).toContain('nope');
    expect(record.writes).toEqual(['comment COR-9', 'state COR-9', 'comment COR-10']);
    expect(record.removals).toEqual([]);
    expect(renderDeliver(report)).toContain('issues: COR-9 Done');
    expect(renderDeliver(report)).toContain('FAILED at issue: COR-10:');
  });

  test('a Linear failure after the merge is step issue with merged true, and removal is skipped', async () => {
    const { partial, record } = seams();
    const broken: LinearClient = {
      async request() {
        throw new LinearError('Linear rejected the request: nope');
      },
    };
    const report = await deliver(
      {
        ...options,
        issues: ['COR-9'],
        completionFiles: [join(sandbox, 'done.md')],
        removeWorktree: { provider: 'claude', name: 'alpha' },
      },
      { ...partial, client: broken },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'issue', mergeCommit: MERGE_COMMIT });
    expect(report.detail).toContain('nope');
    expect(report.issues).toEqual([]);
    expect(record.removals).toEqual([]);
  });

  test('a usage error at the worktree step is step worktree with merged true', async () => {
    const { partial } = seams({ usageError: '--name "x" is not a safe name.' });
    const report = await deliver(
      { ...options, removeWorktree: { provider: 'claude', name: 'x' } },
      partial,
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
  });

  test('a worktree-removal refusal is reported with merged true', async () => {
    const { partial, record } = seams({
      refusal: 'Refusing to remove /c/alpha: it has 2 paths',
    });
    const report = await deliver(
      { ...options, removeWorktree: { provider: 'claude', name: 'alpha' } },
      partial,
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
    expect(report.detail).toContain('Refusing to remove');
    expect(record.removals).toEqual(['alpha']);
  });
});

describe('the completion file', () => {
  test('lists the same headings, in order, as references/execution-report.md', () => {
    const reference = readFileSync(
      join(import.meta.dir, '../../.agents/skills/chef/references/execution-report.md'),
      'utf8',
    );
    const listed = /Level-2 headings, in this order: (.+?)\.\n/.exec(reference)?.[1];
    expect(listed?.split('; ')).toEqual(executionReportHeadings);
  });

  test('accepts an execution report', () => {
    expect(executionReportProblems(sampleReport)).toEqual([]);
  });

  test('names a missing marker and a missing or out-of-order heading', () => {
    expect(executionReportProblems('Delivered.\n')).toHaveLength(
      1 + executionReportHeadings.length,
    );
    const swapped = sampleReport
      .replace('## Verification', '## Placeholder')
      .replace('## Changes', '## Verification');
    expect(executionReportProblems(swapped)).toEqual(['"## Changes" is missing or out of order']);
    expect(executionReportProblems(sampleReport.replace('attempt 1', 'attempt one'))[0]).toContain(
      'first line',
    );
  });

  test('refuses a completion file that is not an execution report, before any merge', async () => {
    const { partial, record } = seams();
    writeFileSync(join(sandbox, 'plain.md'), 'Delivered.\n');
    const error = await rejectionOf(
      deliver(
        { ...options, issues: ['COR-9'], completionFiles: [join(sandbox, 'plain.md')] },
        partial,
      ),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('not an execution report');
    expect(record.merges).toEqual([]);
  });

  test('refuses an invalid second report before any merge or Linear write', async () => {
    const { partial, record } = seams();
    writeFileSync(join(sandbox, 'plain.md'), 'Delivered.\n');
    const error = await rejectionOf(
      deliver(
        {
          ...options,
          issues: ['COR-9', 'COR-10'],
          completionFiles: [join(sandbox, 'done.md'), join(sandbox, 'plain.md')],
        },
        partial,
      ),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('plain.md');
    expect(record.merges).toEqual([]);
    expect(record.requests).toEqual([]);
  });

  test('refuses unequal counts, a missing file and a repeated issue before any merge', async () => {
    const { partial, record } = seams();
    const done = join(sandbox, 'done.md');
    const refused = async (issues: string[], completionFiles: string[]) => {
      const error = await rejectionOf(deliver({ ...options, issues, completionFiles }, partial));
      expect(error).toBeInstanceOf(UsageError);
      return String(error);
    };
    expect(await refused(['COR-9', 'COR-10'], [done])).toContain('pair in order');
    expect(await refused([], [done])).toContain('pair in order');
    expect(await refused(['COR-9'], [join(sandbox, 'absent.md')])).toContain(
      'No such completion file',
    );
    expect(await refused(['COR-9', 'COR-9'], [done, done])).toContain('given twice');
    expect(record.merges).toEqual([]);
  });
});

describe('run', () => {
  const argv = (extra: string[] = []) => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    sandbox,
    '--comment-file',
    options.commentFile,
    ...extra,
  ];

  test('rejects bad usage before touching anything', async () => {
    const base = ['--worktree', sandbox, '--comment-file', join(sandbox, 'comment.md')];
    const usage = async (...args: string[]) => {
      try {
        await run(args);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(await usage('--pr', 'x', ...base)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', '--worktree', sandbox)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--issue', 'COR-1')).toBeInstanceOf(UsageError);
    expect(
      await usage(
        '--pr',
        '1',
        ...base,
        '--issue',
        'COR-1',
        '--issue',
        'COR-2',
        '--completion-file',
        'a.md',
      ),
    ).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--remove-worktree')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--name', 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--bogus')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--usage-log', 'u.tsv')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--transcript', 't.jsonl')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--head', 'abc')).toBeInstanceOf(UsageError);
    // The gate, its retry and the waivers are gone: their flags are unknown options now.
    for (const removed of ['--gate-log', '--max-attempts', '--removed-names', '--log-dir'])
      expect(await usage('--pr', '1', ...base, removed, 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--waive-main-health')).toBeInstanceOf(UsageError);
    expect(
      await usage('--pr', '1', ...base, '--remove-worktree', '--provider', 'nobody', '--name', 'a'),
    ).toBeInstanceOf(UsageError);
    expect(
      await usage(
        '--pr',
        '1',
        ...base,
        '--remove-worktree',
        '--provider',
        'claude',
        '--name',
        '../x',
      ),
    ).toBeInstanceOf(UsageError);
  });

  test('--head, --fixes-main and the spend flags reach the merge gate', async () => {
    const { partial, record } = seams();
    const result = await run(
      argv(['--head', HEAD, '--fixes-main', '--usage-log', '/tmp/u.tsv', '--transcript', '/a']),
      partial,
    );
    expect(result.code).toBe(0);
    expect(record.merges[0]).toMatchObject({
      expectedHead: HEAD,
      fixesMain: true,
      usageLog: '/tmp/u.tsv',
      transcripts: ['/a'],
    });
  });

  test('--issue and --completion-file repeat, pair in order and close each issue', async () => {
    const { partial, record } = seams();
    const second = join(sandbox, 'second.md');
    writeFileSync(second, sampleReport);
    const result = await run(
      argv([
        '--issue',
        'COR-9',
        '--completion-file',
        join(sandbox, 'done.md'),
        '--issue',
        'COR-10',
        '--completion-file',
        second,
        '--json',
      ]),
      partial,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).issues).toEqual([
      { identifier: 'COR-9', state: 'Done' },
      { identifier: 'COR-10', state: 'Done' },
    ]);
    expect(record.writes).toEqual([
      'comment COR-9',
      'state COR-9',
      'comment COR-10',
      'state COR-10',
    ]);
  });

  test('exits 0 with one JSON object for a merge and 1 naming the failed step otherwise', async () => {
    const ok = await run(argv(['--json']), seams().partial);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.output)).toMatchObject({ pr: 12, merged: true, failedStep: null });
    const bad = await run(
      argv(['--json']),
      seams({ merge: refusal('conflict', 'conflicts') }).partial,
    );
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.output).failedStep).toBe('conflict');
  });
});
