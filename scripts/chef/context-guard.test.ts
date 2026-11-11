import { describe, expect, test } from 'bun:test';
import {
  allowedOverTheLimit,
  contextFromTail,
  decide,
  isWorkerCall,
  simpleCommands,
  subagentTranscriptPath,
  thresholds,
  type HookInput,
} from './context-guard.ts';

/** A transcript line: one request whose context is `context` tokens (input + cache read + cache write). */
function request(id: string, context: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: context - 1_002,
        output_tokens: 50,
      },
      content: [],
    },
  });
}

const transcript = (...contexts: number[]) =>
  `${contexts.map((context, index) => request(`msg_${index}`, context)).join('\n')}\n`;

const worker = (tool_name: string, tool_input: unknown): HookInput => ({
  tool_name,
  tool_input,
  agent_id: 'a1b2c3',
  agent_type: 'chef-worker',
  transcript_path: '/projects/p/session.jsonl',
});
const bash = (command: string) => worker('Bash', { command });

const over = transcript(40_000, 151_000);
const denies = (input: HookInput, tail = over, env = {}) =>
  decide(input, tail, env)?.hookSpecificOutput;

describe('context-guard decide', () => {
  test('ignores the main session and every agent type but chef-worker', () => {
    const base = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(decide(base, over)).toBeUndefined();
    expect(decide({ ...base, agent_type: 'chef-worker' }, over)).toBeUndefined();
    expect(decide({ ...base, agent_id: 'a1' }, over)).toBeUndefined();
    for (const agent_type of ['design-reviewer', 'general-purpose', 'Explore', 'chef-worker-2', ''])
      expect(decide({ ...base, agent_id: 'a1', agent_type }, over)).toBeUndefined();
    expect(isWorkerCall({ agent_id: '../x', agent_type: 'chef-worker' })).toBe(false);
  });

  test('allows a call under the limit without a word', () => {
    expect(decide(bash('ls'), transcript(10_000, 100_000))).toBeUndefined();
    expect(decide(bash('ls'), transcript(119_999))).toBeUndefined();
  });

  test('warns at the warning threshold without a permission decision', () => {
    const output = denies(bash('ls'), transcript(120_000));
    expect(output).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(output).not.toHaveProperty('permissionDecision');
    expect((output as { additionalContext: string }).additionalContext).toContain('120,000');
  });

  test('denies every other tool over the limit, naming the context, the limit and the instruction', () => {
    for (const input of [
      bash('bun test'),
      bash('git reset --hard'),
      worker('Edit', { file_path: '/a' }),
      worker('Read', { file_path: '/a' }),
      worker('Write', { file_path: '/a' }),
    ]) {
      const output = denies(input);
      expect(output).toMatchObject({ permissionDecision: 'deny' });
      const reason = (output as { permissionDecisionReason: string }).permissionDecisionReason;
      expect(reason).toContain('Context is 151,000 tokens, over the limit of 150,000');
      expect(reason).toContain(
        'commit what you have, push your branch, and end your turn with a `needs-decision` report listing what is done and what remains',
      );
    }
  });

  test('uses the last request of the transcript, and the exact boundary is over', () => {
    expect(denies(bash('ls'), transcript(150_000))).toMatchObject({ permissionDecision: 'deny' });
    expect(decide(bash('ls'), transcript(200_000, 90_000))).toBeUndefined();
  });

  test('lets the closing git commands through over the limit', () => {
    for (const command of [
      'git add -A',
      'git add scripts/chef/context-guard.ts',
      'git commit -m "COR-1: done"',
      'git commit -m "a; b && c | d"',
      'git commit -F /tmp/message.txt',
      'git commit --amend --no-edit',
      'git push origin cor-2372-context-guard',
      'git push -u origin HEAD',
      'git status',
      'git status --short',
      'git diff --stat',
      'git diff --stat origin/main...HEAD',
      'git log --oneline -5',
      'git -C /work/tree status',
      'git add -A && git commit -m "x" && git push origin branch',
      'git status 2>&1',
      'git rev-parse HEAD',
      'git rev-parse --short HEAD',
      'git --no-pager log -1',
      'git --no-pager diff --stat',
      'git --no-pager status',
      'git -C /work/tree rev-parse HEAD',
      'git -C /work/tree --no-pager log --oneline -3',
      'git -C /work/tree commit -m "line one\n\nline two"',
      'git -C /work/tree push origin HEAD:cor-2372-context-guard',
      'git push -u origin HEAD',
    ]) {
      expect(decide(bash(command), over)).toBeUndefined();
    }
    expect(decide(worker('SubagentHandback', {}), over)).toBeUndefined();
  });

  test('still denies a force push, a deletion and a mirror over the limit', () => {
    for (const command of [
      'git push --force origin branch',
      'git push -f origin branch',
      'git push origin branch --force-with-lease',
      'git push --force-with-lease=branch origin branch',
      'git push --force-if-includes origin branch',
      'git push -uf origin branch',
      'git push origin +branch',
      'git push origin HEAD:+branch',
      'git push origin :branch',
      'git push origin --delete branch',
      'git push --mirror',
      'git push --prune origin',
    ]) {
      expect(allowedOverTheLimit(bash(command))).toBe(false);
      expect(denies(bash(command))).toMatchObject({ permissionDecision: 'deny' });
    }
  });

  test('denies the options that run a program or write a file over the limit', () => {
    for (const command of [
      'git -c core.editor=true commit -m x',
      'git -c core.sshCommand=x push origin HEAD',
      'git -c core.hooksPath=/tmp/h commit -m x',
      'git -ccore.editor=true commit -m x',
      'git --config-env=core.editor=EDITOR commit -m x',
      'git --exec-path=/tmp/x status',
      'git push --receive-pack="sh -c x" /tmp/r HEAD',
      'git push --receive-pack=x origin HEAD',
      'git push --exec=x origin HEAD',
      'git push --upload-pack=x origin HEAD',
      'git log --output=src/a.ts',
      'git log --output src/a.ts',
      'git log --outp=f',
      'git diff --stat --output=f',
      'git diff --stat --ext-diff',
      'git diff --stat --textconv',
      'git log --ext-diff -p',
      'git -C /work/tree -c core.editor=true commit -m x',
      'git --no-pager -c core.pager=x log',
    ]) {
      expect(allowedOverTheLimit(bash(command))).toBe(false);
      expect(denies(bash(command))).toMatchObject({ permissionDecision: 'deny' });
    }
  });

  test('tells a denied worker how to finish under the rules', () => {
    const reason = (denies(bash('bun test')) as { permissionDecisionReason: string })
      .permissionDecisionReason;
    for (const text of [
      'Context is 151,000 tokens, over the limit of 150,000',
      '`git add`',
      '`git commit -m "<message>"`',
      '`needs-decision`',
      'Do not use `cd`, pipes, redirection, heredocs',
      '`git -C <path> <command>`',
      '`git rev-parse HEAD`',
      'The revert check and the name-only diff are skipped here',
    ])
      expect(reason).toContain(text);
  });

  test('denies what only looks like a git command over the limit', () => {
    for (const command of [
      'git diff',
      'git checkout main',
      'git reset --hard HEAD~1',
      'git fetch origin',
      'git rebase main',
      'git status && bun test',
      'git status; rm -rf node_modules',
      'git status | tee out.txt',
      'git commit -m "$(cat message)"',
      'git commit -m "`date`"',
      'git status > out.txt',
      'git status < /dev/null',
      'echo git status',
      'FOO=1 git status',
      'git --exec-path status',
      'git commit -m "unterminated',
      '',
    ]) {
      expect(allowedOverTheLimit(bash(command))).toBe(false);
    }
    expect(allowedOverTheLimit(worker('Bash', {}))).toBe(false);
    expect(allowedOverTheLimit(worker('Bash', null))).toBe(false);
  });

  test('fails open on a missing, empty or malformed transcript', () => {
    for (const tail of [
      undefined,
      '',
      'not json\n{"type":',
      '{"type":"assistant","message":{"id":"m","usage":"x"}}\n',
      `${JSON.stringify({ type: 'user', message: { usage: { input_tokens: 999_999 } } })}\n`,
    ])
      expect(decide(bash('bun test'), tail)).toBeUndefined();
  });

  test('skips a first line cut by reading only the tail', () => {
    const cut = `${request('m_0', 190_000).slice(40)}\n${request('m_1', 20_000)}\n`;
    expect(contextFromTail(cut)).toBe(20_000);
    expect(decide(bash('bun test'), cut)).toBeUndefined();
  });

  test('the environment overrides the limit and the warning', () => {
    const tail = transcript(60_000);
    expect(denies(bash('bun test'), tail, { CHEF_WORKER_CONTEXT_LIMIT: '50000' })).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(denies(bash('ls'), tail, { CHEF_WORKER_CONTEXT_LIMIT: '50000' })).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(
      decide(bash('ls'), transcript(200_000), { CHEF_WORKER_CONTEXT_LIMIT: '300000' }),
    ).toEqual(
      expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({ additionalContext: expect.any(String) }),
      }),
    );
    expect(
      decide(bash('ls'), tail, {
        CHEF_WORKER_CONTEXT_LIMIT: '300000',
        CHEF_WORKER_CONTEXT_WARNING: '70000',
      }),
    ).toBeUndefined();
    // An unusable value falls back to the default.
    expect(
      thresholds({ CHEF_WORKER_CONTEXT_LIMIT: 'lots', CHEF_WORKER_CONTEXT_WARNING: '0' }),
    ).toEqual({
      limit: 150_000,
      warning: 120_000,
    });
    expect(thresholds({ CHEF_WORKER_CONTEXT_LIMIT: '100000' })).toEqual({
      limit: 100_000,
      warning: 100_000,
    });
  });
});

describe('subagentTranscriptPath', () => {
  test('is the subagents directory beside the main transcript', () => {
    expect(subagentTranscriptPath(bash('ls'))).toBe(
      '/projects/p/session/subagents/agent-a1b2c3.jsonl',
    );
  });

  test('takes a transcript path that already is the subagent transcript', () => {
    expect(
      subagentTranscriptPath({
        ...bash('ls'),
        transcript_path: '/projects/p/session/subagents/agent-a1b2c3.jsonl',
      }),
    ).toBe('/projects/p/session/subagents/agent-a1b2c3.jsonl');
  });

  test('is undefined for the main session, another agent, or no transcript path', () => {
    expect(subagentTranscriptPath({ ...bash('ls'), agent_type: 'Explore' })).toBeUndefined();
    expect(subagentTranscriptPath({ ...bash('ls'), transcript_path: undefined })).toBeUndefined();
    expect(subagentTranscriptPath({ ...bash('ls'), transcript_path: '/a/b.txt' })).toBeUndefined();
    expect(subagentTranscriptPath({ tool_name: 'Bash' })).toBeUndefined();
  });
});

describe('simpleCommands', () => {
  test('splits at top-level operators only, never inside quotes', () => {
    expect(simpleCommands('git add -A && git commit -m "a && b; c"')).toEqual([
      ['git', 'add', '-A'],
      ['git', 'commit', '-m', 'a && b; c'],
    ]);
    expect(simpleCommands("git commit -m 'it`s $(fine)'")).toEqual([
      ['git', 'commit', '-m', 'it`s $(fine)'],
    ]);
  });
});
