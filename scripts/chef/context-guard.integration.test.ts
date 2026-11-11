import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';

/**
 * The hook's command line against a real transcript on disk: the main transcript, and beside it
 * `<session>/subagents/agent-<id>.jsonl`, as Claude Code lays them out. One child per case, at
 * module scope, with the assertions below.
 */
const directory = mkdtempSync(join(tmpdir(), 'context-guard-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const mainTranscript = join(directory, 'session.jsonl');
const subagents = join(directory, 'session', 'subagents');
mkdirSync(subagents, { recursive: true });
writeFileSync(mainTranscript, '');

function request(id: string, context: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: context - 4,
      },
      content: [],
    },
  })}\n`;
}

/** A transcript whose last request is `context` tokens, behind `padding` bytes of tool results. */
function transcriptOf(agent: string, context: number, padding = 0): void {
  const filler =
    padding === 0
      ? ''
      : `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(padding) } })}\n`;
  writeFileSync(
    join(subagents, `agent-${agent}.jsonl`),
    `${request('m_0', 10_000)}${request('m_1', context)}${filler}`,
  );
}
transcriptOf('over', 160_000);
transcriptOf('near', 125_000);
transcriptOf('under', 30_000);
// The last request is more than the first read's window behind the end of the file.
transcriptOf('buried', 170_000, 300 * 1024);

async function runHook(stdin: string) {
  const result = await runWithHangGuard(['bun', join(import.meta.dir, 'context-guard.ts')], {
    stdin: Buffer.from(stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const call = (agent_id: string | undefined, command: string, agent_type = 'chef-worker') =>
  JSON.stringify({
    session_id: 'session',
    transcript_path: mainTranscript,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    agent_id,
    agent_type,
  });

const denied = await runHook(call('over', 'bun test'));
const buried = await runHook(call('buried', 'bun test'));
const commit = await runHook(call('over', 'git add -A && git commit -m "wip"'));
const force = await runHook(call('over', 'git push --force origin branch'));
const warned = await runHook(call('near', 'bun test'));
const quiet = await runHook(call('under', 'bun test'));
const reviewer = await runHook(call('over', 'bun test', 'design-reviewer'));
const mainSession = await runHook(call(undefined, 'bun test'));
const missing = await runHook(call('nope', 'bun test'));
const garbage = await runHook('not json');

describe('context-guard command line', () => {
  test('denies a worker over the limit and lets it commit and push', () => {
    expect(denied.code).toBe(0);
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toContain('Context is 160,000 tokens');
    expect(commit).toEqual({ code: 0, stdout: '' });
    expect(JSON.parse(force.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('finds the last request beyond the first read window', () => {
    expect(JSON.parse(buried.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      '170,000',
    );
  });

  test('warns near the limit without a permission decision, and says nothing under it', () => {
    const output = JSON.parse(warned.stdout).hookSpecificOutput;
    expect(output.additionalContext).toContain('125,000');
    expect(output.permissionDecision).toBeUndefined();
    expect(quiet).toEqual({ code: 0, stdout: '' });
  });

  test('ignores other agents and the main session, and fails open on a missing transcript or garbage', () => {
    for (const result of [reviewer, mainSession, missing, garbage])
      expect(result).toEqual({ code: 0, stdout: '' });
  });
});
