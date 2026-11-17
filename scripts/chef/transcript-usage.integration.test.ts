import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

const cliOutcome = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-usage-cli-'));
  const prices = join(directory, 'prices.json');
  const codex = join(directory, 'mixed-codex.jsonl');
  const claude = join(directory, 'mixed-claude.jsonl');
  const malformed = join(directory, 'malformed.jsonl');
  try {
    writeFileSync(
      prices,
      JSON.stringify({
        'gpt-test': { asOf: '2026-11-17', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        'claude-test': { asOf: '2026-11-17', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      }),
    );
    writeJsonl(codex, [
      { type: 'session_meta', payload: {} },
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 11 },
            last_token_usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: {}, last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
    ]);
    writeJsonl(claude, [
      {
        type: 'assistant',
        message: {
          id: 'valid',
          model: 'claude-test',
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: 'assistant',
        message: { id: 'invalid', model: 42, usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]);
    writeJsonl(malformed, [
      { type: 'session_meta', payload: {} },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ]);
    const command = [
      'bun',
      '--no-install',
      'scripts/chef/transcript-usage.ts',
      '--json',
      '--prices',
      prices,
    ];
    const mixed = await runWithHangGuard([...command, codex, claude]);
    expect(mixed.exitCode).toBe(0);
    const reports = JSON.parse(mixed.stdout.toString()) as Array<{
      calls: number;
      complete: boolean;
      cost: number | 'unknown';
      problems: unknown[];
    }>;
    expect(reports).toHaveLength(2);
    expect(reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calls: 1, complete: false, cost: 'unknown' }),
      ]),
    );
    expect(reports.every((report) => report.problems.length > 0)).toBe(true);
    const allMalformed = await runWithHangGuard([...command, malformed]);
    expect(allMalformed.exitCode).toBe(0);
    expect(JSON.parse(allMalformed.stdout.toString())).toEqual([
      expect.objectContaining({ calls: 0, complete: false, cost: 'unknown' }),
    ]);
    const text = await runWithHangGuard([
      'bun',
      '--no-install',
      'scripts/chef/transcript-usage.ts',
      '--prices',
      prices,
      codex,
    ]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.toString()).toContain(
      'Incomplete transcript usage: 1 transcripts, 1 problems; cost is unknown.',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI preserves incomplete mixed and malformed transcript accounting', () => {
  rethrow(cliOutcome);
});
