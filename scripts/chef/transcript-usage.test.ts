import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeCalls,
  codexCalls,
  contextOf,
  detectProvider,
  readTranscript,
  report,
  run,
  transcriptFiles,
  UsageError,
} from './transcript-usage.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'transcript-usage-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function claudeEntry(
  id: string,
  timestamp: string,
  usage: Record<string, number>,
  content: unknown[] = [{ type: 'text', text: 'x' }],
  model = 'claude-opus-5-5',
) {
  return {
    type: 'assistant',
    timestamp,
    message: { id, model, usage, content },
  };
}

/** A coordinator transcript: one response split over two entries, a second call, then a rewrite. */
function claudeTranscript(): unknown[] {
  const first = {
    input_tokens: 10,
    cache_creation_input_tokens: 1_000,
    cache_read_input_tokens: 0,
    output_tokens: 50,
  };
  return [
    {
      type: 'user',
      message: { role: 'user', content: 'go' },
      timestamp: '2026-10-22T10:00:00.000Z',
    },
    claudeEntry('m1', '2026-10-22T10:00:01.000Z', first, [{ type: 'text', text: 'thinking' }]),
    claudeEntry('m1', '2026-10-22T10:00:01.500Z', first, [
      { type: 'tool_use', id: 't1', name: 'Bash' },
    ]),
    claudeEntry('m2', '2026-10-22T10:00:05.000Z', {
      input_tokens: 5,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1_000,
      output_tokens: 20,
    }),
    // Twenty minutes later the cache has expired: the whole context is written again.
    claudeEntry('m3', '2026-10-22T10:20:05.000Z', {
      input_tokens: 5,
      cache_creation_input_tokens: 90_000,
      cache_read_input_tokens: 0,
      output_tokens: 10,
    }),
    'not json at all',
  ];
}

function codexTranscript(): unknown[] {
  const usage = (input: number, cached: number, output: number, total: number) => ({
    type: 'event_msg',
    timestamp: '2026-10-16T13:18:13.607Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
  });
  return [
    { type: 'session_meta', payload: { id: 's1', cwd: '/tmp' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    usage(52_535, 0, 199, 52_734),
    // A repeated event with an unchanged running total is not a new call.
    usage(52_535, 0, 199, 52_734),
    usage(60_000, 52_000, 300, 113_034),
  ];
}

function write(path: string, entries: unknown[]): string {
  writeFileSync(
    path,
    entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'),
  );
  return path;
}

describe('Claude Code transcripts', () => {
  test('keys calls by message id, counts tool-use blocks once, and keeps usage', () => {
    const calls = claudeCodeCalls(
      claudeTranscript().filter((entry) => typeof entry !== 'string') as Record<string, unknown>[],
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      uncachedInput: 10,
      cacheWrite: 1_000,
      toolCalls: 1,
    });
    expect(contextOf(calls[1]!)).toBe(1_205);
  });

  test('reports a full-context rewrite and the gap before it', () => {
    const usage = readTranscript(write(join(sandbox, 'parent.jsonl'), claudeTranscript()))!;
    const result = report(usage, undefined);
    expect(result.provider).toBe('claude-code');
    expect(result.calls).toBe(3);
    expect(result.rewrites).toBe(1);
    expect(result.rewriteTokens).toBe(90_000);
    expect(result.rewriteGapsMinutes).toEqual([20]);
    expect(result.maxContext).toBe(90_005);
    expect(result.lastContext).toBe(90_005);
    expect(result.toolCalls).toBe(1);
    expect(result.cost).toBeUndefined();
  });

  test('does not count a call that read more from cache than it wrote as a rewrite', () => {
    const usage = readTranscript(write(join(sandbox, 'parent.jsonl'), claudeTranscript()))!;
    expect(report(usage, undefined, 100).rewrites).toBe(1);
  });

  test('skips synthetic entries and totals each model separately', () => {
    const usage = {
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
    };
    const path = write(join(sandbox, 'mixed.jsonl'), [
      claudeEntry('s1', '2026-10-22T10:00:00.000Z', usage, undefined, '<synthetic>'),
      claudeEntry('a1', '2026-10-22T10:00:01.000Z', usage, undefined, 'claude-sonnet-5-5'),
      claudeEntry('a2', '2026-10-22T10:00:02.000Z', usage, undefined, 'claude-fable-5-1'),
      claudeEntry('a3', '2026-10-22T10:00:03.000Z', usage, undefined, 'claude-sonnet-5-5'),
    ]);
    const result = report(readTranscript(path)!, undefined);
    expect(result.models).toEqual(['claude-fable-5-1', 'claude-sonnet-5-5']);
    expect(result.byModel['claude-sonnet-5-5']).toEqual({
      calls: 2,
      uncachedInput: 2,
      cacheWrite: 4,
      cacheRead: 6,
      output: 8,
    });
    expect(run([path]).output).toContain('claude-code claude-fable-5-1: calls=1');
  });

  test('labels a subagent transcript with its meta description', () => {
    const directory = join(sandbox, 'subagents');
    mkdirSync(directory);
    write(join(directory, 'agent-a.jsonl'), claudeTranscript());
    writeFileSync(
      join(directory, 'agent-a.meta.json'),
      JSON.stringify({ description: 'B35 quote-reply' }),
    );
    expect(readTranscript(join(directory, 'agent-a.jsonl'))!.label).toBe('B35 quote-reply');
  });
});

describe('Codex session logs', () => {
  test('counts one call per token_count whose running total grew, with cached input split out', () => {
    const calls = codexCalls(codexTranscript() as Record<string, unknown>[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      model: 'gpt-6.1-sol',
      uncachedInput: 52_535,
      cacheRead: 0,
      output: 199,
    });
    expect(calls[1]).toMatchObject({ uncachedInput: 8_000, cacheRead: 52_000 });
    expect(calls[1]!.toolCalls).toBeUndefined();
  });

  test('detects each provider from its entries', () => {
    expect(detectProvider(codexTranscript() as Record<string, unknown>[])).toBe('codex');
    expect(detectProvider([{ type: 'assistant', message: {} }])).toBe('claude-code');
    expect(detectProvider([{ type: 'something-else' }])).toBeUndefined();
  });
});

describe('prices', () => {
  test('costs every call from the supplied table', () => {
    const usage = readTranscript(write(join(sandbox, 'parent.jsonl'), claudeTranscript()))!;
    const price = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
    const result = report(usage, { 'claude-opus-5-5': price });
    const expected =
      ((10 + 5 + 5) * 4 + (1_000 + 200 + 90_000) * 5 + 1_000 * 0.4 + (50 + 20 + 10) * 20) /
      1_000_000;
    expect(result.cost).toBeCloseTo(expected, 10);
  });

  test('leaves the cost unknown when a model has no price', () => {
    const usage = readTranscript(write(join(sandbox, 'parent.jsonl'), claudeTranscript()))!;
    expect(
      report(usage, {
        'another-model': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      }).cost,
    ).toBeUndefined();
  });
});

describe('the command line', () => {
  test('walks a directory and prints a text report', () => {
    write(join(sandbox, 'coordinator.jsonl'), claudeTranscript());
    mkdirSync(join(sandbox, 'codex'));
    write(join(sandbox, 'codex', 'rollout-1.jsonl'), codexTranscript());
    expect(transcriptFiles(sandbox)).toHaveLength(2);
    const { code, output } = run([sandbox]);
    expect(code).toBe(0);
    expect(output).toContain('claude-code claude-opus-5-5: calls=3');
    expect(output).toContain('codex gpt-6.1-sol: calls=2');
    expect(output).toContain('Full-context rewrites: 1 calls');
  });

  test('emits parseable JSON and a priced total', () => {
    write(join(sandbox, 'coordinator.jsonl'), claudeTranscript());
    const pricesPath = join(sandbox, 'prices.json');
    writeFileSync(
      pricesPath,
      JSON.stringify({
        'claude-opus-5-5': {
          input: 4,
          output: 20,
          cacheRead: 0.4,
          cacheWrite: 5,
        },
      }),
    );
    const parsed = JSON.parse(
      run(['--json', '--prices', pricesPath, join(sandbox, 'coordinator.jsonl')]).output,
    );
    expect(parsed[0].calls).toBe(3);
    expect(typeof parsed[0].cost).toBe('number');
  });

  test('returns 1 when no transcript has model calls', () => {
    writeFileSync(
      join(sandbox, 'empty.jsonl'),
      jsonl([{ type: 'user', message: { content: 'hi' } }]),
    );
    expect(run([sandbox]).code).toBe(1);
  });

  test('rejects missing paths, unknown options and a malformed price table', () => {
    expect(() => run([])).toThrow(UsageError);
    expect(() => run([join(sandbox, 'missing')])).toThrow(UsageError);
    expect(() => run(['--verbose', sandbox])).toThrow(UsageError);
    const bad = join(sandbox, 'bad-prices.json');
    writeFileSync(bad, JSON.stringify({ model: { input: 1 } }));
    expect(() => run(['--prices', bad, sandbox])).toThrow(UsageError);
  });
});
