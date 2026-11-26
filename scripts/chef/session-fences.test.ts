import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { handleHookEvent, type HookInput } from '../host-sessions.ts';
import { briefVersionIn, volatileImagePaths } from './report-schema.ts';
import {
  appendCorrection,
  attachScreenshot,
  escapePathOf,
  ledgerPathOf,
  reportProblems,
  ReportRefusal,
  writeReport,
} from './report.ts';
import { context, lease, world, type World } from './session-fences.test-support.ts';
import { stopBlockLimit } from './session-fences.ts';

describe('AskUserQuestion', () => {
  const question = (sessionId: string): HookInput => ({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [] },
  });

  test('is denied for a leased session and allowed for an unleased one', async () => {
    const setting = await world();
    await lease(setting, 'coordinator');
    const denied = await handleHookEvent(question('coordinator'), context(setting));
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain('run-1');
    expect(await handleHookEvent(question('groom-session'), context(setting))).toBeUndefined();
  });

  test('is allowed once the lease expires', async () => {
    const setting = await world();
    await lease(setting, 'coordinator', '1970-01-01T00:00:10Z');
    expect(await handleHookEvent(question('coordinator'), context(setting))).toBeUndefined();
  });
});

describe('a chef-worker stop', () => {
  const briefText = (version: string) => `# COR-1: x\n\nBrief version: ${version}\n`;

  async function worker(setting: World, version = 'aaaaaaaaaaaa') {
    await writeFile(join(setting.briefs, 'COR-1.md'), briefText(version));
    const path = join(setting.root, 'worker-transcript.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00Z', message: { role: 'user', content: 'Read tmp/chef/briefs/COR-1.md and deliver it.' } })}\n`,
    );
    return path;
  }

  const stop = (transcriptPath: string, extra: Partial<HookInput> = {}): HookInput => ({
    hook_event_name: 'SubagentStop',
    session_id: 'coordinator',
    agent_id: 'agent-1',
    agent_type: 'chef-worker',
    agent_transcript_path: transcriptPath,
    ...extra,
  });

  const input = {
    head: 'abc1234',
    checks: 'focused-checks: all steps passed',
    status: 'READY',
    criteria: [{ id: 'AC1', status: 'met-on-branch', evidence: 'test passes' }],
    correctionsRead: [],
  };

  function report(
    setting: World,
    overrides: Record<string, unknown> = {},
    options: { briefVersion?: string; at?: Date } = {},
  ) {
    return writeReport({
      issue: 'COR-1',
      input: { ...input, ...overrides },
      mainCheckout: setting.main,
      worktree: join(setting.root, 'worktree'),
      branch: 'chef/x',
      briefVersion: options.briefVersion ?? 'aaaaaaaaaaaa',
      ...(options.at === undefined ? {} : { at: options.at }),
    });
  }

  /** A git reader whose worktree head is `pushed` and whose diff from any older head is `changed`. */
  const gitAt =
    (pushed: string, changed: string[]) =>
    (args: string[]): string | undefined =>
      args[0] === 'rev-parse' ? pushed : args[0] === 'diff' ? changed.join('\n') : undefined;

  test('refuses to write against a brief amended since the worker read it, and the stop stays blocked until it does', async () => {
    const setting = await world();
    const path = await worker(setting);
    // The coordinator amends: the brief is re-rendered (version B) and a correction recorded.
    await writeFile(join(setting.briefs, 'COR-1.md'), briefText('bbbbbbbbbbbb'));
    const entry = appendCorrection(setting.state, 'COR-1', {
      branch: 'chef/x',
      text: 'criterion 16: the header is 700px',
      at: new Date(0),
    });
    // The worker read version A; writing for A is refused, naming the amendment.
    expect(() => report(setting, {}, { briefVersion: 'aaaaaaaaaaaa' })).toThrow(
      /amended after you read it[\s\S]*c1: criterion 16/,
    );
    const stillBlocked = await handleHookEvent(stop(path), context(setting));
    expect(stillBlocked?.decision).toBe('block');
    // Omitting the version is refused too: the report records what was read, never the disk.
    expect(() => report(setting, {}, { briefVersion: undefined as unknown as string })).toThrow(
      /--brief-version/,
    );
    report(setting, { correctionsRead: [entry.id] }, { briefVersion: 'bbbbbbbbbbbb' });
    expect(await handleHookEvent(stop(path), context(setting))).toBeUndefined();
  });

  test('refuses a report left by an earlier worker: another head, or written before this worker started', async () => {
    const setting = await world();
    const path = await worker(setting);
    report(setting);
    const stale = (git: ReturnType<typeof gitAt>) =>
      handleHookEvent(
        stop(path),
        context(setting, {
          chef: { stateDirectory: setting.state, briefsDirectory: setting.briefs, git },
        }),
      );
    // The worktree moved past the report's head with code, so the report is an earlier worker's.
    const moved = await stale(gitAt('def5678', ['scripts/thing.ts']));
    expect(moved?.decision).toBe('block');
    expect(moved?.reason).toContain('not the pushed head def5678');
    // The ledger commit alone moves HEAD, which is allowed; so is an equal head.
    expect(
      await stale(gitAt('def5678', ['documentation/criteria-ledger/COR-1.json'])),
    ).toBeUndefined();
    expect(await stale(gitAt('abc1234ffff', []))).toBeUndefined();
    // A report written before this worker's transcript began is stale even at the same head.
    await writeFile(
      path,
      `${JSON.stringify({ type: 'user', timestamp: '2999-01-01T00:00:00Z', message: { content: 'Read tmp/chef/briefs/COR-1.md.' } })}\n`,
    );
    const earlier = await stale(gitAt('abc1234', []));
    expect(earlier?.decision).toBe('block');
    expect(earlier?.reason).toContain('written before this worker started');
  });

  test('blocks a correction-round worker without a report, from the prompt the workflow gives it', async () => {
    const setting = await world();
    await writeFile(join(setting.briefs, 'COR-1.md'), briefText('aaaaaaaaaaaa'));
    report(setting);
    const path = join(setting.root, 'correction-transcript.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ type: 'user', timestamp: '2999-01-01T00:00:00Z', message: { content: 'cd into /worktree, the worktree of branch chef/x. The brief file is /main/tmp/chef/briefs/COR-1.md: read it again.' } })}\n`,
    );
    const output = await handleHookEvent(stop(path, { agent_id: 'agent-2' }), context(setting));
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('written before this worker started');
  });

  test('a stop let through after the block limit leaves a marker that the workflow check refuses, until a valid report clears it', async () => {
    const setting = await world();
    const path = await worker(setting);
    for (let attempt = 0; attempt <= stopBlockLimit; attempt += 1)
      await handleHookEvent(stop(path), context(setting));
    const check = () =>
      reportProblems({
        stem: 'COR-1',
        stateDirectory: setting.state,
        briefsDirectory: setting.briefs,
        strict: true,
      });
    expect(existsSync(escapePathOf(setting.state, 'COR-1'))).toBe(true);
    expect(check()?.join('\n')).toContain('let through after the block limit');
    // Even a valid report written by hand beside the marker does not land.
    report(setting);
    writeFileSync(escapePathOf(setting.state, 'COR-1'), '{}');
    expect(check()?.join('\n')).toContain('let through after the block limit');
    // A worker that writes a valid report through `write` clears the marker.
    report(setting);
    expect(existsSync(escapePathOf(setting.state, 'COR-1'))).toBe(false);
  });

  test('is blocked, with the command that writes the report, when there is none', async () => {
    const setting = await world();
    const path = await worker(setting);
    const output = await handleHookEvent(stop(path), context(setting));
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('bun scripts/chef/report.ts write COR-1');
  });

  test('goes through with a valid report, which also writes the committed ledger', async () => {
    const setting = await world();
    const path = await worker(setting);
    report(setting);
    expect(await handleHookEvent(stop(path), context(setting))).toBeUndefined();
    const ledger = JSON.parse(
      readFileSync(ledgerPathOf(join(setting.root, 'worktree'), 'COR-1'), 'utf8'),
    );
    expect(ledger).toMatchObject({
      issue: 'COR-1',
      branch: 'chef/x',
      checkedAt: 'abc1234',
      briefVersion: 'aaaaaaaaaaaa',
      criteria: [{ id: 'AC1', status: 'met-on-branch' }],
    });
  });

  test('is blocked for a report that breaks the schema', async () => {
    const setting = await world();
    const path = await worker(setting);
    await mkdir(join(setting.state, 'reports'), { recursive: true });
    await writeFile(
      join(setting.state, 'reports', 'COR-1.json'),
      JSON.stringify({ issue: 'COR-1', status: 'DONE' }),
    );
    const output = await handleHookEvent(stop(path), context(setting));
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('status is READY or BLOCKED');
  });

  test('refuses a READY report with an unmet criterion, and a BLOCKED one without a reason', async () => {
    const setting = await world();
    await worker(setting);
    const unmet = [{ id: 'AC1', status: 'not-met' }];
    expect(() => report(setting, { criteria: unmet })).toThrow(/READY report has no not-met/);
    expect(() => report(setting, { criteria: unmet, status: 'BLOCKED' })).toThrow(
      /names its reason/,
    );
    expect(() =>
      report(setting, { criteria: unmet, status: 'BLOCKED', reason: 'needs main' }),
    ).not.toThrow();
  });

  test('is blocked when the brief was amended after the worker read it', async () => {
    const setting = await world();
    const path = await worker(setting);
    report(setting);
    await writeFile(join(setting.briefs, 'COR-1.md'), briefText('bbbbbbbbbbbb'));
    const output = await handleHookEvent(stop(path), context(setting));
    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('amended after you read it');
  });

  test('is blocked while a correction entry for the branch is unread, and goes through once listed', async () => {
    const setting = await world();
    const path = await worker(setting);
    const entry = appendCorrection(setting.state, 'COR-1', {
      branch: 'chef/x',
      text: 'criterion 16: the header is 700px',
      at: new Date(0),
    });
    report(setting);
    const blocked = await handleHookEvent(stop(path), context(setting));
    expect(blocked?.decision).toBe('block');
    expect(blocked?.reason).toContain(entry.id);
    report(setting, { correctionsRead: [entry.id] });
    expect(await handleHookEvent(stop(path), context(setting))).toBeUndefined();
  });

  test('lets a worker that cannot write the file go after the block limit, and logs it', async () => {
    const setting = await world();
    const path = await worker(setting);
    for (let attempt = 0; attempt < stopBlockLimit; attempt += 1) {
      const blocked = await handleHookEvent(stop(path), context(setting));
      expect(blocked?.decision).toBe('block');
    }
    const logged: string[] = [];
    const last = await handleHookEvent(
      stop(path),
      context(setting, { report: (lines) => logged.push(...lines) }),
    );
    expect(last).toBeUndefined();
    expect(logged.join('\n')).toContain('blocked 3 times');
  });

  test('is never blocked for another agent type, and fails open when its input is missing', async () => {
    const setting = await world();
    const path = await worker(setting);
    expect(
      await handleHookEvent(stop(path, { agent_type: 'stickler' }), context(setting)),
    ).toBeUndefined();
    const logged: string[] = [];
    const log = (lines: readonly string[]) => logged.push(...lines);
    expect(
      await handleHookEvent(
        stop(join(setting.root, 'gone.jsonl')),
        context(setting, { report: log }),
      ),
    ).toBeUndefined();
    await writeFile(
      join(setting.root, 'plain.jsonl'),
      '{"type":"user","message":{"content":"hi"}}\n',
    );
    expect(
      await handleHookEvent(
        stop(join(setting.root, 'plain.jsonl')),
        context(setting, { report: log }),
      ),
    ).toBeUndefined();
    expect(
      await handleHookEvent(stop(path), context(setting, { report: log, chef: undefined })),
    ).toBeUndefined();
    expect(logged).toHaveLength(3);
  });
});

describe('owner feedback intake', () => {
  test('a correction entry is tied to its branch, numbered, and refuses a volatile image path', async () => {
    const setting = await world();
    const first = appendCorrection(setting.state, 'COR-1', {
      branch: 'chef/x',
      text: 'also do this',
      at: new Date(0),
    });
    const second = appendCorrection(setting.state, 'COR-1', {
      branch: 'chef/x',
      text: 'and that',
      at: new Date(1),
    });
    expect([first.id, second.id]).toEqual(['c1', 'c2']);
    expect(first.branch).toBe('chef/x');
    expect(() =>
      appendCorrection(setting.state, 'COR-1', {
        branch: 'chef/x',
        text: 'see /private/tmp/claude-501/images/shot.png',
        at: new Date(2),
      }),
    ).toThrow(ReportRefusal);
  });

  test('a screenshot is stored under the coordinator state, never a temporary folder', async () => {
    const setting = await world();
    const source = join(setting.root, 'shot.png');
    await writeFile(source, 'png bytes');
    const stored = attachScreenshot(setting.state, 'COR-1', source);
    expect(stored.startsWith(join(setting.state, 'attachments', 'COR-1'))).toBe(true);
    expect(existsSync(stored)).toBe(true);
    expect(
      volatileImagePaths('x /private/tmp/a/b.PNG and /tmp/c.jpeg and /var/folders/x/y.webp'),
    ).toEqual(['/private/tmp/a/b.PNG', '/tmp/c.jpeg', '/var/folders/x/y.webp']);
    expect(volatileImagePaths('/Users/me/run/attachments/shot.png /tmp/notes.txt')).toEqual([]);
  });

  test('briefVersionIn reads the version line of a brief', () => {
    expect(briefVersionIn('# x\n\nBrief version: 0123456789ab\nSize: 5 bytes.\n')).toBe(
      '0123456789ab',
    );
    expect(briefVersionIn('# x\n')).toBeUndefined();
  });
});

describe('wiring', () => {
  const root = join(import.meta.dir, '..', '..');

  test('chef-worker may not ask the user, and the hook sees AskUserQuestion and every stop', () => {
    const agent = readFileSync(join(root, '.claude', 'agents', 'chef-worker.md'), 'utf8');
    expect(agent).toMatch(/^disallowedTools: AskUserQuestion$/m);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(
      (settings.hooks['PreToolUse'] ?? []).some(
        (group) =>
          group.matcher?.split('|').includes('AskUserQuestion') === true &&
          group.hooks.some((hook) => hook.command.includes('scripts/host-sessions.ts hook')),
      ),
    ).toBe(true);
    expect(settings.hooks['SubagentStop']?.[0]?.hooks[0]?.command).toContain(
      'scripts/host-sessions.ts hook',
    );
  });
});
