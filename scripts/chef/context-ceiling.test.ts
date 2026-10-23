import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../hang-guard.ts';
import {
  currentContext,
  decide,
  defaultUrgentTokens,
  defaultWarnTokens,
  thresholdsFrom,
} from './context-ceiling.ts';

function assistantLine(id: string, cacheRead: number, padding = ''): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: padding }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: cacheRead,
        output_tokens: 3,
      },
    },
  });
}

function withTranscript(lines: string[], body: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'context-ceiling-'));
  try {
    const path = join(directory, 'session.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);
    body(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('thresholdsFrom', () => {
  test('defaults, overrides, and invalid values', () => {
    expect(thresholdsFrom({})).toEqual({ warn: defaultWarnTokens, urgent: defaultUrgentTokens });
    expect(
      thresholdsFrom({ CHEF_CONTEXT_WARN_TOKENS: '100', CHEF_CONTEXT_URGENT_TOKENS: '200' }),
    ).toEqual({ warn: 100, urgent: 200 });
    expect(
      thresholdsFrom({ CHEF_CONTEXT_WARN_TOKENS: 'abc', CHEF_CONTEXT_URGENT_TOKENS: '-4' }),
    ).toEqual({ warn: defaultWarnTokens, urgent: defaultUrgentTokens });
  });

  test.each([
    ['an override above warn', { CHEF_CONTEXT_URGENT_TOKENS: '300000' }, 300_000],
    ['an override below warn is raised to warn', { CHEF_CONTEXT_URGENT_TOKENS: '10' }, 250_000],
    ['an invalid override keeps the default', { CHEF_CONTEXT_URGENT_TOKENS: 'x' }, 350_000],
  ])('the urgent threshold: %s', (_label, environment, expected) => {
    expect(thresholdsFrom(environment).urgent).toBe(expected);
  });
});

describe('currentContext', () => {
  test('is the context of the last model call', () => {
    withTranscript([assistantLine('a', 100), assistantLine('b', 900)], (path) => {
      expect(currentContext(path)).toBe(915);
    });
  });

  test('finds a model call before a huge trailing entry by widening the window', () => {
    const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(600_000) } });
    withTranscript([assistantLine('a', 777), huge], (path) => {
      expect(currentContext(path)).toBe(792);
    });
  });

  test('is undefined for a missing, empty, or call-free transcript', () => {
    expect(currentContext('/nonexistent/transcript.jsonl')).toBeUndefined();
    withTranscript([], (path) => expect(currentContext(path)).toBeUndefined());
    withTranscript(['not json', JSON.stringify({ type: 'user', message: {} })], (path) =>
      expect(currentContext(path)).toBeUndefined(),
    );
  });
});

describe('decide', () => {
  const input = (tool: string, toolInput: unknown = {}) => ({
    transcript_path: '/t.jsonl',
    tool_name: tool,
    tool_input: toolInput,
  });
  const at = (tokens: number) => () => tokens;

  test('says nothing at or below the warn threshold', () => {
    expect(decide(input('Bash'), {}, at(250_000))).toBeUndefined();
  });

  test('warns above the warn threshold and still allows the call', () => {
    const decision = decide(input('Bash'), {}, at(250_001));
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(decision?.hookSpecificOutput.additionalContext).toContain('handoff brief');
  });

  test.each([
    ['just above warn', 250_001, 'handoff threshold'],
    ['at the urgent threshold', 350_000, 'handoff threshold'],
    ['just above urgent', 350_001, 'URGENT'],
    ['far above the old 400K block', 900_000, 'URGENT'],
  ])('escalates the warning by band and never denies: %s', (_label, tokens, expected) => {
    for (const call of [
      input('Bash', { command: 'bun run check' }),
      input('Read'),
      input('Agent'),
    ]) {
      const decision = decide(call, {}, at(tokens));
      expect(decision?.hookSpecificOutput.permissionDecision).toBe('allow');
      const text = decision?.hookSpecificOutput.additionalContext ?? '';
      expect(text).toContain(expected);
      if (expected === 'URGENT') expect(text).toContain('never hand_off_to_session');
      else expect(text).not.toContain('URGENT');
    }
  });

  test('honors the environment thresholds and the off switch', () => {
    const environment = { CHEF_CONTEXT_WARN_TOKENS: '10', CHEF_CONTEXT_URGENT_TOKENS: '20' };
    expect(decide(input('Read'), environment, at(10))).toBeUndefined();
    expect(
      decide(input('Read'), environment, at(15))?.hookSpecificOutput.additionalContext,
    ).toContain('handoff threshold');
    expect(
      decide(input('Read'), environment, at(25))?.hookSpecificOutput.additionalContext,
    ).toContain('URGENT');
    expect(
      decide(input('Read'), { ...environment, CHEF_CONTEXT_CEILING: 'off' }, at(25)),
    ).toBeUndefined();
  });

  test('fails open: unreadable transcript, no path, or a subagent call', () => {
    expect(decide(input('Read'), {}, () => undefined)).toBeUndefined();
    expect(decide({ tool_name: 'Read' }, {}, at(999_999))).toBeUndefined();
    expect(decide({ ...input('Read'), agent_id: 'sub' }, {}, at(999_999))).toBeUndefined();
  });
});

/** The `import.meta.main` block, run at module scope: a child per case, assertions below. */
async function runHook(stdin: string) {
  const result = await runWithHangGuard(['bun', join(import.meta.dir, 'context-ceiling.ts')], {
    stdin: Buffer.from(stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const overTheCeiling = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-ceiling-cli-'));
  try {
    const path = join(directory, 'session.jsonl');
    writeFileSync(path, `${assistantLine('a', 500_000)}\n`);
    return await runHook(
      JSON.stringify({ transcript_path: path, tool_name: 'Read', tool_input: {} }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();
const garbage = await runHook('not json');

describe('command line', () => {
  test('warns and allows over the old ceiling', () => {
    expect(overTheCeiling.code).toBe(0);
    const output = JSON.parse(overTheCeiling.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('allow');
    expect(output.additionalContext).toContain('URGENT');
  });

  test('fails open on garbage input', () => {
    expect(garbage).toEqual({ code: 0, stdout: '' });
  });
});
