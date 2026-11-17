import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountOutcome,
  assessBudget,
  resumeBudget,
  verifyTaskBank,
  type OutcomeRecord,
} from './outcome-accounting.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'outcome-accounting-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function write(name: string, entries: unknown[]): string {
  const path = join(sandbox, name);
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

function codex(total: number, input: number, output: number, timestamp: string) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
  };
}

function outcome(path: string): OutcomeRecord {
  return {
    id: 'outcome-1',
    source: 'COR-1',
    task: 'accounting',
    provider: 'codex',
    requestedModel: 'gpt-test',
    observedModel: 'gpt-test',
    requestedEffort: 'high',
    observedEffort: 'high',
    policyRevision: 'policy@1',
    requiredCriteria: ['AC1'],
    completedCriteria: ['AC1'],
    deliveryState: 'delivered',
    reviewerEffort: 'low',
    humanInterventions: ['approval'],
    verificationMilliseconds: 20,
    attempts: [
      {
        id: 'root',
        kind: 'root',
        status: 'failed',
        transcriptPaths: [path],
        endedAt: '2026-11-17T20:58:06.000Z',
      },
      {
        id: 'resume',
        kind: 'restart',
        status: 'accepted',
        transcriptPaths: [path, path],
        startedAt: '2026-11-17T20:58:07.283Z',
      },
    ],
  };
}

describe('outcome accounting', () => {
  test('scopes a cumulative Codex transcript to linked resumed attempts and deduplicates paths', () => {
    const path = write('rollout.jsonl', [
      { type: 'session_meta', payload: {} },
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      codex(11, 10, 1, '2026-11-17T20:58:06.000Z'),
      codex(33, 20, 2, '2026-11-17T20:58:08.000Z'),
    ]);
    const result = accountOutcome(outcome(path), {
      'gpt-test': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    expect(result.tokens).toEqual({ uncachedInput: 30, cacheRead: 0, cacheWrite: 0, output: 3 });
    expect(result.includedTranscriptPaths).toHaveLength(1);
    expect(result.cost).toBeCloseTo(0.000033);
    expect(result.outcomeSuccess).toBe(true);
    expect(result.deliveryThroughput).toBe(1);
  });

  test('keeps missing usage and unknown pricing unknown instead of calling either zero', () => {
    const path = write('broken.jsonl', [
      { type: 'session_meta', payload: {} },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ]);
    const result = accountOutcome(outcome(path));
    expect(result.incompleteUsage).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'missing-usage' })]),
    );
    expect(result.cost).toBe('unknown');
  });

  test('preserves absent allowances and stops dispatch when cumulative reservations reach one', () => {
    expect(
      assessBudget({ spentTokens: 12, reservedTokens: 4, hardLimitEnforced: false }),
    ).toMatchObject({ allowanceTokens: 'unknown', mayDispatch: true, hardLimitEnforced: false });
    expect(
      assessBudget({
        allowanceTokens: 16,
        spentTokens: 12,
        reservedTokens: 4,
        hardLimitEnforced: true,
      }),
    ).toMatchObject({
      cumulativeCommittedTokens: 16,
      softLimitReached: true,
      mayDispatch: false,
      hardLimitEnforced: true,
    });
    expect(
      resumeBudget(
        { allowanceTokens: 16, spentTokens: 4, reservedTokens: 3, hardLimitEnforced: true },
        { spentTokens: 5, reservedTokens: 4, hardLimitEnforced: true },
      ),
    ).toMatchObject({ allowanceTokens: 16, spentTokens: 9, reservedTokens: 7 });
  });

  test('does not call an accepted attempt successful before complete delivery', () => {
    const path = write('empty.jsonl', [{ type: 'session_meta', payload: {} }]);
    const record = outcome(path);
    record.deliveryState = 'pending';
    record.completedCriteria = [];
    const result = accountOutcome(record);
    expect(result).toMatchObject({ outcomeSuccess: false, deliveryThroughput: 0 });
    expect(result.incompleteUsage).toEqual([
      expect.objectContaining({ message: expect.stringContaining('no model calls') }),
    ]);
  });

  test('requires two snapshots per family with one held out', async () => {
    const bank = JSON.parse(await Bun.file('scripts/chef/fixtures/sdlc-task-bank.json').text());
    expect(verifyTaskBank(bank)).toEqual([]);
  });
});
