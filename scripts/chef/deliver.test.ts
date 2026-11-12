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
import { directMerge, type DirectMergeOptions } from './direct-merge.ts';
import { LinearError, type LinearClient } from './linear.ts';
import type { MergeGateOptions, MergeGateReport } from './merge-gate.ts';
import { UsageError, type Runner, type RunnerResult } from './process-runner.ts';
import type { GuardsResult } from './text-guards.ts';
import type { UsageTotals } from './transcript-usage.ts';
import { Refusal, type RemoveOptions } from './worktree.ts';

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
    /** The processes the removal reports it ended. */
    ended?: { pid: number; command: string; cwd: string }[];
    /** The identifier whose state change Linear rejects. */
    failState?: string;
  } = {},
) {
  const record = {
    merges: [] as MergeGateOptions[],
    removals: [] as string[],
    removeCalls: [] as RemoveOptions[],
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
      remove: (removeOptions: RemoveOptions) => {
        record.removals.push(removeOptions.name);
        record.removeCalls.push(removeOptions);
        if (overrides.refusal !== undefined) throw new Refusal(overrides.refusal);
        if (overrides.usageError !== undefined) throw new UsageError(overrides.usageError);
        return { path: '/c/alpha', branch: 'b', remoteDeleted: true, ended: overrides.ended ?? [] };
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
      branch: null,
      merged: true,
      mergeCommit: MERGE_COMMIT,
      mergeable: 'MERGEABLE',
      mainHealthWarning: null,
      guardsAlreadyFailing: [],
      failedStep: null,
      detail: null,
      issues: [],
      leftOpen: [],
      acceptedReverts: [],
      worktree: { removed: true, detail: '/c/alpha' },
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
      merge: mergedReport({ mainHealthWarning: 'main main.yml at aaaa: failure (RED).' }),
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
      {
        ...options,
        issues: ['COR-9'],
        completionFiles: [join(sandbox, 'done.md')],
        closes: ['COR-9'],
      },
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

  test('a --pr delivery of an issue it names with --issue leaves its state alone without --closes', async () => {
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, issues: ['COR-9'], completionFiles: [join(sandbox, 'done.md')] },
      partial,
    );
    expect(report).toMatchObject({
      merged: true,
      failedStep: null,
      issues: [],
      leftOpen: ['COR-9'],
    });
    expect(record.writes).toEqual(['comment COR-9']);
    expect(record.requests).not.toContain('IssueSetState');
    const lines = renderDeliver(report).split('\n');
    expect(lines.at(-1)).toContain('left open, state untouched: COR-9');
  });

  test('with no issue named it says that nothing was closed and writes nothing to Linear', async () => {
    const { partial, record } = seams();
    const report = await deliver(options, partial);
    expect(record.requests).toEqual([]);
    expect(renderDeliver(report).split('\n').at(-1)).toContain('no issue closed');
  });

  test('--closes closes only the issue it names and leaves the others open', async () => {
    const { partial, record } = seams();
    const second = join(sandbox, 'second.md');
    writeFileSync(second, sampleReport);
    const report = await deliver(
      {
        ...options,
        issues: ['COR-9', 'COR-10'],
        completionFiles: [join(sandbox, 'done.md'), second],
        closes: ['COR-10'],
      },
      partial,
    );
    expect(report).toMatchObject({
      issues: [{ identifier: 'COR-10', state: 'Done' }],
      leftOpen: ['COR-9'],
    });
    expect(record.writes).toEqual(['comment COR-9', 'comment COR-10', 'state COR-10']);
  });

  test('--closes must name an --issue, refused before any merge', async () => {
    const { partial, record } = seams();
    const error = await rejectionOf(deliver({ ...options, closes: ['COR-9'] }, partial));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('--closes COR-9 names no --issue');
    expect(record.merges).toEqual([]);
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
        closes: ['COR-9', 'COR-10'],
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
        closes: ['COR-9', 'COR-10', 'COR-11'],
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
      },
      { ...partial, client: broken },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'issue', mergeCommit: MERGE_COMMIT });
    expect(report.detail).toContain('nope');
    expect(report.issues).toEqual([]);
    expect(record.removals).toEqual([]);
  });

  test('removes the delivered worktree by default, naming its path and the delivered tip', async () => {
    const { partial, record } = seams();
    const report = await deliver({ ...options, expectedHead: HEAD }, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(report.worktree).toEqual({ removed: true, detail: '/c/alpha' });
    expect(record.removeCalls).toEqual([
      {
        configPath: options.configPath,
        name: sandbox,
        keepRemote: false,
        deliveredTip: HEAD,
        endProcesses: true,
      },
    ]);
    expect(renderDeliver(report).split('\n')[1]).toBe('worktree removed: /c/alpha');
  });

  test('names the processes the removal ended inside the delivered worktree', async () => {
    const { partial } = seams({ ended: [{ pid: 10, command: 'bun', cwd: '/c/alpha' }] });
    const report = await deliver({ ...options, expectedHead: HEAD }, partial);
    expect(report.worktree).toEqual({
      removed: true,
      detail: '/c/alpha (ended 1 process(es) left running inside it)',
    });
  });

  test('a pull request delivery with no --head names the pull request head as the delivered tip', async () => {
    const { partial, record } = seams();
    await deliver(options, partial);
    expect(record.removeCalls[0]?.deliveredTip).toBe(HEAD);
  });

  test('--keep-worktree removes nothing and says so', async () => {
    const { partial, record } = seams();
    const report = await deliver({ ...options, keepWorktree: true }, partial);
    expect(record.removals).toEqual([]);
    expect(report.worktree).toEqual({ removed: false, detail: 'kept by --keep-worktree' });
    expect(renderDeliver(report).split('\n')[1]).toBe('worktree kept: kept by --keep-worktree');
  });

  test('a worktree the removal refuses is kept with its reason and the delivery still succeeds', async () => {
    const { partial, record } = seams({
      refusal: 'Refusing to remove /c/alpha: Git reports it locked',
    });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(report.worktree?.removed).toBe(false);
    expect(report.worktree?.detail).toContain('locked');
    expect(record.removals).toEqual([sandbox]);
    expect(renderDeliver(report)).toContain('worktree kept: Refusing to remove /c/alpha');
    expect(renderDeliver(report)).not.toContain('FAILED');
  });

  test('a usage error from the removal is kept too, never a failed step', async () => {
    const { partial } = seams({ usageError: 'not a safe name.' });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(report.worktree).toEqual({ removed: false, detail: 'not a safe name.' });
  });

  test('a delivery that did not merge touches no worktree', async () => {
    const { partial, record } = seams({ merge: refusal('conflict', 'x') });
    const report = await deliver(options, partial);
    expect(report.worktree).toBeNull();
    expect(record.removals).toEqual([]);
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
  test('--help prints the usage, with every option, and exits 0 without touching anything', async () => {
    const { partial, record } = seams();
    const result = await run(['--help'], partial);
    expect(result.code).toBe(0);
    expect(result.output).toStartWith('Usage:');
    for (const option of ['--pr', '--branch', '--closes', '--intended', '--help'])
      expect(result.output).toContain(option);
    expect(record.merges).toEqual([]);
  });

  const argv = (extra: string[] = []) => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    sandbox,
    '--comment-file',
    join(sandbox, 'comment.md'),
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
    // The old spelling is gone: removal is the default, and `--keep-worktree` opts out.
    expect(await usage('--pr', '1', ...base, '--remove-worktree')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--name', 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--provider', 'claude')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--bogus')).toBeInstanceOf(UsageError);
    // A pull request and a branch are exclusive, and one of them is required.
    expect(await usage('--worktree', sandbox)).toBeInstanceOf(UsageError);
    expect(
      await usage('--pr', '1', '--branch', 'work', '--head', HEAD, ...base, '--message-file', 'm'),
    ).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--usage-log', 'u.tsv')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--transcript', 't.jsonl')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--head', 'abc')).toBeInstanceOf(UsageError);
    // The gate, its retry and the waivers are gone: their flags are unknown options now.
    for (const removed of ['--gate-log', '--max-attempts', '--removed-names', '--log-dir'])
      expect(await usage('--pr', '1', ...base, removed, 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--health-file')).toBeInstanceOf(UsageError);
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
        '--closes',
        'COR-9',
        '--closes',
        'COR-10',
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

const BRANCH = 'cor-9-widgets';
const TREE = '1'.repeat(40);
const BASE_TREE = '2'.repeat(40);
const SQUASH = 'e'.repeat(40);
const NEW_BLOB = '5'.repeat(40);
const OLD_BLOB = '6'.repeat(40);
const OLDER_BLOB = '7'.repeat(40);
const EARLIER = '8'.repeat(40);

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });

/** A fake `git` that answers a clean branch merge, with `answers` overriding single commands. */
function branchWorld(answers: Record<string, RunnerResult> = {}) {
  const calls: string[] = [];
  const messageFile = join(sandbox, 'message.md');
  const defaults: Record<string, RunnerResult> = {
    [`fetch origin main ${BRANCH}`]: reply(),
    [`rev-parse --verify refs/remotes/origin/${BRANCH}^{commit}`]: reply(`${HEAD}\n`),
    'rev-parse --verify refs/remotes/origin/main^{commit}': reply(`${BASE}\n`),
    [`merge-base ${HEAD} ${BASE}`]: reply(`${BASE}\n`),
    [`diff --name-only ${BASE} ${HEAD}`]: reply('a.ts\n'),
    [`rev-parse -q --verify ${HEAD}:a.ts`]: reply(`${NEW_BLOB}\n`),
    [`rev-parse -q --verify ${BASE}:a.ts`]: reply(`${OLD_BLOB}\n`),
    [`log -n 60 --since=2 days ago --format=%H ${BASE} -- a.ts`]: reply(`${EARLIER}\n`),
    [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${OLDER_BLOB}\n`),
    [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${TREE}\n`),
    [`rev-parse ${BASE}^{tree}`]: reply(`${BASE_TREE}\n`),
    [`commit-tree ${TREE} -p ${BASE} -F ${messageFile}`]: reply(`${SQUASH}\n`),
    [`push origin ${SQUASH}:refs/heads/main`]: reply(),
    [`push origin --delete ${BRANCH}`]: reply(),
  };
  const runner: Runner = (command) => {
    const key = command.slice(1).join(' ');
    calls.push(key);
    return answers[key] ?? defaults[key] ?? reply('', 1, `unexpected command: ${key}`);
  };
  return { runner, calls, messageFile };
}

const guardsPass = (): GuardsResult => ({ ok: true, failures: [] });
const guardsFail = (
  guard: string,
  findings: string[] = [`${guard} - found a problem`],
): GuardsResult => ({
  ok: false,
  failures: [{ guard, findings, output: findings.join(' | ') }],
});

/** `deliver --branch` with the real direct merge over a fake `git`, and the guards injected. */
async function deliverBranch(
  world: ReturnType<typeof branchWorld>,
  guards: (revision: string, only?: readonly string[]) => GuardsResult = guardsPass,
  extra: Partial<DeliverOptions> = {},
  usage: { usage?: () => UsageTotals; now?: () => Date } = {},
) {
  writeFileSync(world.messageFile, 'COR-9: Add widgets\n');
  const { partial, record } = seams();
  const report = await deliver(
    {
      configPath: options.configPath,
      branch: BRANCH,
      expectedHead: HEAD,
      messageFile: world.messageFile,
      worktree: sandbox,
      ...extra,
    },
    {
      ...partial,
      directMerge: async (directOptions) =>
        directMerge(directOptions, { runner: world.runner, guards, ...usage }),
    },
  );
  return { report, record };
}

describe('deliver --branch', () => {
  test('squashes the branch into main with one commit, pushes it, then deletes the branch', async () => {
    const world = branchWorld();
    const revisions: string[] = [];
    const { report, record } = await deliverBranch(world, (revision) => {
      revisions.push(revision);
      return guardsPass();
    });
    expect(report).toMatchObject({
      pr: null,
      branch: BRANCH,
      merged: true,
      mergeCommit: SQUASH,
      failedStep: null,
      issues: [],
      leftOpen: [],
      acceptedReverts: [],
    });
    expect(record.merges).toEqual([]);
    // The guards ran on the commit that was pushed, and nothing touched a working tree.
    expect(revisions).toEqual([SQUASH]);
    const writes = world.calls.filter((call) => /^(push|commit-tree)/.test(call));
    expect(writes).toEqual([
      `commit-tree ${TREE} -p ${BASE} -F ${world.messageFile}`,
      `push origin ${SQUASH}:refs/heads/main`,
      `push origin --delete ${BRANCH}`,
    ]);
    expect(world.calls.some((call) => /^(checkout|merge |reset|worktree|stash)/.test(call))).toBe(
      false,
    );
    expect(renderDeliver(report)).toStartWith(
      `branch ${BRANCH} merged=true mergeCommit=eeeeeeeeeeee`,
    );
  });

  test('a branch that is not the pinned head is refused at head, with nothing written', async () => {
    const world = branchWorld({
      [`rev-parse --verify refs/remotes/origin/${BRANCH}^{commit}`]: reply(`${'9'.repeat(40)}\n`),
    });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'head' });
    expect(report.detail).toContain('not the head pinned at acceptance');
    expect(world.calls.some((call) => call.startsWith('push'))).toBe(false);
  });

  test('a failed fetch is named at head', async () => {
    const world = branchWorld({ [`fetch origin main ${BRANCH}`]: reply('', 128, 'no such ref') });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'head' });
  });

  test('a file set back to the state before a recent commit is refused at revert', async () => {
    const world = branchWorld({
      [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${NEW_BLOB}\n`),
      [`log -1 --format=%h %s ${EARLIER}`]: reply('abc1234 Add the widget\n'),
    });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'revert' });
    expect(report.detail).toContain('a.ts undoes abc1234 Add the widget');
    expect(world.calls.some((call) => call.startsWith('merge-tree'))).toBe(false);
  });

  const undoneFile = () =>
    branchWorld({
      [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${NEW_BLOB}\n`),
      [`log -1 --format=%h %s ${EARLIER}`]: reply('abc1234 Add the widget\n'),
    });

  test('--intended accepts the revert finding for the path it names and the merge goes on', async () => {
    const { report } = await deliverBranch(undoneFile(), guardsPass, { intended: ['a.ts'] });
    expect(report).toMatchObject({
      merged: true,
      failedStep: null,
      acceptedReverts: ['a.ts undoes abc1234 Add the widget'],
    });
    expect(renderDeliver(report)).toContain('revert accepted as intended: a.ts undoes abc1234');
  });

  test('--intended for another path still fails on the finding, and a path with no finding is an error', async () => {
    const other = await deliverBranch(undoneFile(), guardsPass, { intended: ['b.ts'] });
    expect(other.report).toMatchObject({ merged: false, failedStep: 'revert' });
    expect(other.report.detail).toContain('a.ts undoes');
    const stale = await deliverBranch(branchWorld(), guardsPass, { intended: ['a.ts'] });
    expect(stale.report).toMatchObject({ merged: false, failedStep: 'revert' });
    expect(stale.report.detail).toContain('--intended a.ts names no revert finding');
  });

  test('--intended is refused with --pr, before anything runs', async () => {
    const { partial, record } = seams();
    const error = await rejectionOf(deliver({ ...options, intended: ['a.ts'] }, partial));
    expect(error).toBeInstanceOf(UsageError);
    expect(record.merges).toEqual([]);
  });

  test('a conflict with main is refused at conflict, with no commit made', async () => {
    const world = branchWorld({
      [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${TREE}\nCONFLICT\n`, 1),
    });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'conflict' });
    expect(world.calls.some((call) => /^(commit-tree|push)/.test(call))).toBe(false);
  });

  test('a branch that changes nothing is refused rather than pushed as an empty commit', async () => {
    const world = branchWorld({
      [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${BASE_TREE}\n`),
    });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
    expect(report.detail).toContain('changes nothing');
  });

  test('a guard that fails on the merged tree and passes on main is refused at guards, with nothing pushed', async () => {
    const world = branchWorld();
    const { report, record } = await deliverBranch(
      world,
      (revision) => (revision === BASE ? guardsPass() : guardsFail('check-middle-dot-separators')),
      { issues: ['COR-9'], completionFiles: [join(sandbox, 'done.md')] },
    );
    expect(report).toMatchObject({ merged: false, failedStep: 'guards', guardsAlreadyFailing: [] });
    expect(report.detail).toContain('check-middle-dot-separators');
    expect(world.calls.some((call) => call.startsWith('push'))).toBe(false);
    expect(record.requests).toEqual([]);
  });

  test('a guard failure refuses the merge only for a finding main does not have, with no declaration', async () => {
    const WAIT = 'check-wait-for-element-assertions';
    const onBranch = guardsFail(WAIT, ['a.test.ts:1 - absence']);
    const failing = (branch: GuardsResult, onBase: GuardsResult) => (revision: string) =>
      revision === BASE ? onBase : branch;
    const deliverFailing = (branch: GuardsResult, onBase: GuardsResult) =>
      deliverBranch(branchWorld(), failing(branch, onBase));

    // Every finding is main's own: merged, and reported as already failing on main, never silently.
    const inherited = await deliverFailing(
      onBranch,
      guardsFail(WAIT, ['a.test.ts:1 - absence', 'b.test.ts:2 - identity']),
    );
    expect(inherited.report).toMatchObject({
      merged: true,
      failedStep: null,
      guardsAlreadyFailing: [{ guard: WAIT, findings: 1 }],
    });
    expect(renderDeliver(inherited.report)).toContain(
      `WARNING guards: already failing on main, with no finding of this change's own: ${WAIT} (1 output lines)`,
    );

    // Same guard, but a finding main does not have: the change's own, refused.
    const newFinding = await deliverFailing(onBranch, guardsFail(WAIT, ['c.test.ts:3 - absence']));
    expect(newFinding.report).toMatchObject({ merged: false, failedStep: 'guards' });
    // A different guard failing on main, by name alone, is no baseline.
    const otherGuard = await deliverFailing(onBranch, guardsFail('check-runtime-detection'));
    expect(otherGuard.report).toMatchObject({ merged: false, failedStep: 'guards' });
    expect(otherGuard.report.detail).toContain(WAIT);
    // Main passing the guard is no baseline.
    const clean = await deliverFailing(onBranch, guardsPass());
    expect(clean.report).toMatchObject({ merged: false, failedStep: 'guards' });
    // A failure with no findings cannot be matched against anything.
    const silent = await deliverFailing(guardsFail(WAIT, []), guardsFail(WAIT, []));
    expect(silent.report).toMatchObject({ merged: false, failedStep: 'guards' });
    // A second failing guard that main does not fail is the change's own, beside an inherited one.
    const both: GuardsResult = {
      ok: false,
      failures: [
        ...onBranch.failures,
        { guard: 'check-middle-dot-separators', findings: ['x:1 - dot'], output: 'x:1 - dot' },
      ],
    };
    const mixed = await deliverFailing(both, guardsFail(WAIT, ['a.test.ts:1 - absence']));
    expect(mixed.report).toMatchObject({ merged: false, failedStep: 'guards' });
    expect(mixed.report.detail).toContain(WAIT);
    expect(mixed.report.detail).toContain('check-middle-dot-separators');
    // Two inherited guards are both reported.
    const two: GuardsResult = {
      ok: false,
      failures: [
        ...onBranch.failures,
        ...guardsFail('check-runtime-detection', ['r:1 - x']).failures,
      ],
    };
    const bothInherited = await deliverFailing(two, two);
    expect(bothInherited.report.guardsAlreadyFailing).toEqual([
      { guard: WAIT, findings: 1 },
      { guard: 'check-runtime-detection', findings: 1 },
    ]);

    // The base run is limited to the guards that failed on the merged tree.
    const asked: (readonly string[] | undefined)[] = [];
    await deliverBranch(branchWorld(), (revision, only) => {
      if (revision === BASE) asked.push(only);
      return onBranch;
    });
    expect(asked).toEqual([[WAIT]]);
    // A tree whose guards all pass never runs them on main.
    const revisions: string[] = [];
    await deliverBranch(branchWorld(), (revision) => {
      revisions.push(revision);
      return guardsPass();
    });
    expect(revisions).toEqual([SQUASH]);
  });

  test('--fixes-main is for a pull request: a branch merge refuses it before anything runs', async () => {
    const world = branchWorld();
    const error = await rejectionOf(deliverBranch(world, guardsPass, { fixesMain: true }));
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('--fixes-main applies only with --pr');
    expect(world.calls).toEqual([]);
  });

  test('a rejected push changes nothing: the branch is kept and no issue is closed', async () => {
    const world = branchWorld({
      [`push origin ${SQUASH}:refs/heads/main`]: reply('', 1, '! [rejected] (fetch first)'),
    });
    const { report, record } = await deliverBranch(world, guardsPass, {
      issues: ['COR-9'],
      completionFiles: [join(sandbox, 'done.md')],
    });
    expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'merge' });
    expect(report.detail).toContain('rejected');
    expect(world.calls).not.toContain(`push origin --delete ${BRANCH}`);
    expect(record.requests).toEqual([]);
  });

  test('a branch that cannot be deleted is step delete with merged true, and no issue is closed', async () => {
    const world = branchWorld({ [`push origin --delete ${BRANCH}`]: reply('', 1, 'denied') });
    const { report, record } = await deliverBranch(world, guardsPass, {
      issues: ['COR-9'],
      completionFiles: [join(sandbox, 'done.md')],
    });
    expect(report).toMatchObject({ merged: true, mergeCommit: SQUASH, failedStep: 'delete' });
    expect(record.requests).toEqual([]);
  });

  test('a branch merge without --closes comments on the issue and leaves its state alone', async () => {
    const { report, record } = await deliverBranch(branchWorld(), guardsPass, {
      issues: ['COR-9'],
      completionFiles: [join(sandbox, 'done.md')],
    });
    expect(report).toMatchObject({
      merged: true,
      failedStep: null,
      issues: [],
      leftOpen: ['COR-9'],
    });
    expect(record.writes).toEqual(['comment COR-9']);
    expect(renderDeliver(report).split('\n').at(-1)).toContain('left open, state untouched: COR-9');
  });

  test('closes the issues after the merge, pairing each with its completion file in order', async () => {
    const second = join(sandbox, 'second.md');
    writeFileSync(second, sampleReport);
    const { report, record } = await deliverBranch(branchWorld(), guardsPass, {
      issues: ['COR-9', 'COR-10'],
      completionFiles: [join(sandbox, 'done.md'), second],
      closes: ['COR-9', 'COR-10'],
    });
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
    expect(record.removals).toEqual([sandbox]);
  });

  test('unpaired issues, an unsafe branch or a bad head are refused before anything runs', async () => {
    const world = branchWorld();
    const refused = async (extra: Partial<DeliverOptions>) => {
      const error = await rejectionOf(deliverBranch(world, guardsPass, extra));
      expect(error).toBeInstanceOf(UsageError);
      return String(error);
    };
    expect(await refused({ issues: ['COR-9'], completionFiles: [] })).toContain('pair in order');
    expect(await refused({ branch: 'main' })).toContain('default branch');
    expect(await refused({ branch: '--delete' })).toContain('not a safe branch name');
    expect(await refused({ branch: 'a..b' })).toContain('not a safe branch name');
    expect(await refused({ expectedHead: 'abc' })).toContain('not a full commit SHA');
    expect(world.calls).toEqual([]);
  });

  test('exactly one of a pull request and a branch, each with its own file, is required', async () => {
    const { partial } = seams();
    const refused = async (extra: Partial<DeliverOptions>) => {
      const error = await rejectionOf(
        deliver({ configPath: options.configPath, worktree: sandbox, ...extra }, partial),
      );
      expect(error).toBeInstanceOf(UsageError);
      return String(error);
    };
    const message = join(sandbox, 'comment.md');
    expect(await refused({})).toContain('exactly one of --pr and --branch');
    expect(
      await refused({ pr: 1, branch: BRANCH, expectedHead: HEAD, messageFile: message }),
    ).toContain('exactly one of --pr and --branch');
    expect(await refused({ pr: 1 })).toContain('--pr needs --comment-file');
    expect(await refused({ pr: 1, commentFile: message, messageFile: message })).toContain(
      '--message-file applies only with --branch',
    );
    expect(await refused({ branch: BRANCH, expectedHead: HEAD })).toContain('needs --message-file');
    expect(await refused({ branch: BRANCH, messageFile: message })).toContain('needs --head');
    expect(
      await refused({
        branch: BRANCH,
        expectedHead: HEAD,
        messageFile: message,
        commentFile: message,
      }),
    ).toContain('--comment-file applies only with --pr');
  });

  test('no direct merge runner is a named failure, never a silent skip', async () => {
    const report = await deliver(
      {
        configPath: options.configPath,
        branch: BRANCH,
        expectedHead: HEAD,
        messageFile: join(sandbox, 'comment.md'),
        worktree: sandbox,
      },
      {},
    );
    expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
  });

  test('records the spend with branch:<name> where a pull request number would go', async () => {
    const usageLog = join(sandbox, 'out', 'usage.tsv');
    const { report } = await deliverBranch(
      branchWorld(),
      guardsPass,
      { usageLog, transcripts: [join(sandbox, 'comment.md')] },
      {
        usage: () => ({ input: 1, cachedInput: 2, output: 3 }),
        now: () => new Date('2026-11-11T12:00:00.000Z'),
      },
    );
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(readFileSync(usageLog, 'utf8')).toBe(
      `2026-11-11T12:00:00.000Z\tbranch:${BRANCH}\t${SQUASH}\t1\t2\t3\n`,
    );
  });

  test('run reads --branch, --head and --message-file and reports the branch as JSON', async () => {
    const seen: DirectMergeOptions[] = [];
    const result = await run(
      [
        '--config',
        options.configPath,
        '--branch',
        BRANCH,
        '--head',
        HEAD,
        '--worktree',
        sandbox,
        '--message-file',
        join(sandbox, 'comment.md'),
        '--json',
      ],
      {
        directMerge: async (directOptions) => {
          seen.push(directOptions);
          return {
            branch: BRANCH,
            head: HEAD,
            base: BASE,
            merged: true,
            mergeCommit: SQUASH,
            failedStep: null,
            detail: null,
          };
        },
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ pr: null, branch: BRANCH, merged: true });
    expect(seen[0]).toMatchObject({ branch: BRANCH, head: HEAD });
  });
});
