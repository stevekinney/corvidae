import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../hang-guard.ts';
import {
  currentContext,
  decide,
  defaultBlockTokens,
  defaultUrgentTokens,
  defaultWarnTokens,
  isHandoffCall,
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
    expect(thresholdsFrom({})).toEqual({
      warn: defaultWarnTokens,
      urgent: defaultUrgentTokens,
      block: defaultBlockTokens,
    });
    expect(
      thresholdsFrom({ CHEF_CONTEXT_WARN_TOKENS: '100', CHEF_CONTEXT_BLOCK_TOKENS: '200' }),
    ).toEqual({ warn: 100, urgent: 200, block: 200 });
    expect(
      thresholdsFrom({ CHEF_CONTEXT_WARN_TOKENS: 'abc', CHEF_CONTEXT_BLOCK_TOKENS: '-4' }),
    ).toEqual({
      warn: defaultWarnTokens,
      urgent: defaultUrgentTokens,
      block: defaultBlockTokens,
    });
  });

  test.each([
    ['an override inside the band', { CHEF_CONTEXT_URGENT_TOKENS: '300000' }, 300_000],
    ['an override below warn is raised to warn', { CHEF_CONTEXT_URGENT_TOKENS: '10' }, 250_000],
    [
      'an override above block is lowered to block',
      { CHEF_CONTEXT_URGENT_TOKENS: '9999999' },
      400_000,
    ],
    ['an invalid override keeps the default', { CHEF_CONTEXT_URGENT_TOKENS: 'x' }, 325_000],
  ])('the urgent threshold: %s', (_label, environment, expected) => {
    expect(thresholdsFrom(environment).urgent).toBe(expected);
  });

  test('a block threshold below the warn threshold never blocks before it warns', () => {
    const { warn, block } = thresholdsFrom({
      CHEF_CONTEXT_WARN_TOKENS: '500000',
      CHEF_CONTEXT_BLOCK_TOKENS: '300000',
    });
    expect(block).toBeGreaterThanOrEqual(warn);
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

describe('isHandoffCall', () => {
  test('allows the brief file, session tools, and git handoff commands only', () => {
    expect(isHandoffCall('Write', { file_path: '/repo/tmp/chef/briefs/COR-1.md' })).toBe(true);
    expect(isHandoffCall('Write', { file_path: '/repo/src/index.ts' })).toBe(false);
    expect(isHandoffCall('Write', { file_path: '/repo/tmp/chef/../../src/a.ts' })).toBe(false);
    expect(isHandoffCall('mcp__ccd_session__start_session', {})).toBe(true);
    expect(isHandoffCall('mcp__ccd_session__hand_off_to_session', {})).toBe(false);
    expect(isHandoffCall('SendMessage', { to: 'local_7aa567bf-be0e-46d8' })).toBe(true);
    expect(isHandoffCall('SendMessage', { to: 'researcher' })).toBe(false);
    expect(isHandoffCall('SendMessage', { to: 'a1b2c3-agent' })).toBe(false);
    expect(isHandoffCall('SendMessage', {})).toBe(false);
    for (const command of [
      'git status',
      'git commit -m "wip (x)"',
      'git push origin HEAD',
      'git -C /a/b log',
    ]) {
      expect(isHandoffCall('Bash', { command })).toBe(true);
    }
    for (const command of [
      'git status; rm -rf x',
      'git push && bun test',
      'git commit -m "$(cat f)"',
      'git reset --hard',
      'bun run check',
      'git status | tee f',
    ]) {
      expect(isHandoffCall('Bash', { command })).toBe(false);
    }
    expect(isHandoffCall('Read', { file_path: '/repo/a.ts' })).toBe(false);
  });
});

describe('isHandoffCall for ToolSearch', () => {
  test.each([
    ['select of start_session', { query: 'select:mcp__ccd_session__start_session' }, true],
    [
      'select that adds hand_off_to_session',
      {
        query: 'select:mcp__ccd_session__start_session,mcp__ccd_session__hand_off_to_session',
      },
      false,
    ],
    [
      'select with spaces around the names',
      { query: 'select: mcp__ccd_session__start_session , SendMessage' },
      true,
    ],
    ['select that adds Bash', { query: 'select:mcp__ccd_session__start_session,Bash' }, false],
    [
      'select that adds another server tool',
      { query: 'select:mcp__ccd_session__start_session,mcp__foo__bar' },
      false,
    ],
    ['select of a lookalike name', { query: 'select:mcp__ccd_session__start_session_x' }, false],
    ['empty select', { query: 'select:' }, false],
    ['keyword query', { query: 'session start handoff' }, false],
    ['keyword query with a plus', { query: '+ccd_session start' }, false],
    ['missing query', {}, false],
    ['non-string query', { query: 5 }, false],
  ])('%s', (_label, input, expected) => {
    expect(isHandoffCall('ToolSearch', input)).toBe(expected);
  });

  test('a missing input is denied', () => {
    expect(isHandoffCall('ToolSearch', undefined)).toBe(false);
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
    ['at the urgent threshold', 325_000, 'handoff threshold'],
    ['just above urgent', 325_001, 'URGENT'],
    ['at the block threshold', 400_000, 'URGENT'],
  ])('escalates the warning by band: %s', (_label, tokens, expected) => {
    const decision = decide(input('Bash'), {}, at(tokens));
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('allow');
    const text = decision?.hookSpecificOutput.additionalContext ?? '';
    expect(text).toContain(expected);
    if (expected === 'URGENT') expect(text).toContain('blocked at 400K');
    else expect(text).not.toContain('URGENT');
  });

  test('denies other calls above the block threshold and allows a handoff', () => {
    const denied = decide(input('Read', { file_path: '/a' }), {}, at(400_001));
    expect(denied?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain('tmp/chef/');
    const allowed = decide(input('Bash', { command: 'git status' }), {}, at(400_001));
    expect(allowed?.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('honors the environment thresholds and the off switch', () => {
    const environment = { CHEF_CONTEXT_WARN_TOKENS: '10', CHEF_CONTEXT_BLOCK_TOKENS: '20' };
    expect(decide(input('Read'), environment, at(15))?.hookSpecificOutput.permissionDecision).toBe(
      'allow',
    );
    expect(decide(input('Read'), environment, at(25))?.hookSpecificOutput.permissionDecision).toBe(
      'deny',
    );
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
  test('denies over the ceiling', () => {
    expect(overTheCeiling.code).toBe(0);
    expect(JSON.parse(overTheCeiling.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('fails open on garbage input', () => {
    expect(garbage).toEqual({ code: 0, stdout: '' });
  });
});
