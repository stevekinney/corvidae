/**
 * How the Checks page reads its results (COR-2114, rows C2-05, C2-06, C2-08, C2-09, C2-10 and C2-14):
 * the filter the address holds and what it sends, the check in words, the status word of every
 * outcome, line two, where a row leads, and what each facet offers.
 */
import { statusForStatusDotWord } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import { CHECK_OUTCOME_WORDS } from '../../app/copy/checks.ts';
import { CHECK_OUTCOMES } from '../../lib/bureau-checks.ts';
import { checkFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  checkLineTwo,
  checkOptions,
  checkPath,
  checkTitle,
  checkWord,
  checksAreFiltered,
  checksQuery,
  outcomesOffered,
  parseChecksFilter,
  scoreText,
  serializeChecksFilter,
  splitCheckId,
} from './checks-rows.ts';

const search = (query: string) => new URLSearchParams(query);
const agentLabel = (name: string) => (name === 'tool-runner' ? 'Tool runner' : name);

describe('the filter the address holds', () => {
  test('is All with nothing applied when the address holds none', () => {
    expect(parseChecksFilter(search(''))).toEqual({ segment: 'all' });
    expect(checksAreFiltered({ segment: 'all' })).toBe(false);
  });

  test('reads each facet and keeps them in one spelling, so a shared address reloads to the same filters', () => {
    const address = 'kind=scorer&check=politeness%402&outcome=fail&agent=tool-runner&time=week';
    const filter = parseChecksFilter(search(address));
    expect(filter).toEqual({
      segment: 'scorer',
      check: 'politeness@2',
      outcome: 'fail',
      agent: 'tool-runner',
      time: 'week',
    });
    expect(serializeChecksFilter(filter)).toBe(address);
    expect(parseChecksFilter(search(serializeChecksFilter(filter)))).toEqual(filter);
    expect(checksAreFiltered(filter)).toBe(true);
  });

  test('takes no value it does not know as a filter', () => {
    expect(
      parseChecksFilter(search('kind=nonsense&outcome=maybe&time=decade&check=&agent=%20')),
    ).toEqual({ segment: 'all' });
  });

  test('drops an outcome the chosen kind cannot have, as choosing the kind does (C2-06)', () => {
    expect(parseChecksFilter(search('kind=guardrail&outcome=pass'))).toEqual({
      segment: 'guardrail',
    });
    expect(parseChecksFilter(search('kind=guardrail&outcome=redact'))).toEqual({
      segment: 'guardrail',
      outcome: 'redact',
    });
    expect(parseChecksFilter(search('kind=tripwire&outcome=tripwire')).outcome).toBe('tripwire');
    expect(parseChecksFilter(search('kind=session&outcome=fail')).outcome).toBeUndefined();
    expect(parseChecksFilter(search('outcome=tainted')).outcome).toBe('tainted');
  });
});

describe('what the page asks the operation', () => {
  const NOW = Date.parse('2026-11-02T16:45:00Z');

  test('sends nothing for no filter', () => {
    expect(checksQuery({ segment: 'all' }, NOW)).toEqual({});
  });

  test('sends each filter as the operation names it, so the server narrows the rows', () => {
    expect(
      checksQuery(
        { segment: 'goal', check: 'judge@1', outcome: 'fail', agent: 'worker', time: 'day' },
        NOW,
      ),
    ).toEqual({
      kind: 'goal.attempt.validated',
      checkId: 'judge@1',
      outcome: 'fail',
      agentName: 'worker',
      since: NOW - 24 * 60 * 60 * 1_000,
    });
    expect(checksQuery({ segment: 'scorer' }, NOW)).toEqual({ kind: 'scorer.recorded' });
    expect(checksQuery({ segment: 'guardrail' }, NOW)).toEqual({ kind: 'run.guardrail' });
    expect(checksQuery({ segment: 'tripwire' }, NOW)).toEqual({ kind: 'run.tripwire' });
    expect(checksQuery({ segment: 'session' }, NOW)).toEqual({ kind: 'session.tainted' });
  });

  test('reaches back from now by each time preset', () => {
    for (const [time, hours] of [
      ['hour', 1],
      ['day', 24],
      ['week', 24 * 7],
      ['month', 24 * 30],
    ] as const) {
      expect(checksQuery({ segment: 'all', time }, NOW).since).toBe(NOW - hours * 3_600_000);
    }
  });
});

describe('the outcome of a result', () => {
  test('has one status word each, and Cinder gives each its one tone (C2-10)', () => {
    expect(CHECK_OUTCOMES.map((outcome) => CHECK_OUTCOME_WORDS[outcome])).toEqual([
      'Check met',
      'Check not met',
      "Couldn't check",
      'Unavailable',
      'Canceled',
      'No verdict',
      'Blocked',
      'Warned',
      'Sanitized',
      'Redacted',
      'Tripped',
      'Flagged',
    ]);
    const tones = Object.fromEntries(
      CHECK_OUTCOMES.map((outcome) => [outcome, statusForStatusDotWord(checkWord({ outcome }))]),
    );
    expect(tones).toEqual({
      pass: 'success',
      fail: 'neutral',
      error: 'danger',
      unavailable: 'neutral',
      canceled: 'neutral',
      indeterminate: 'neutral',
      block: 'neutral',
      warn: 'neutral',
      sanitize: 'neutral',
      redact: 'neutral',
      tripwire: 'danger',
      tainted: 'neutral',
    });
  });

  test('is never shown as its raw value', () => {
    for (const outcome of CHECK_OUTCOMES) {
      expect(checkWord({ outcome })).not.toBe(outcome);
    }
  });

  test('is offered for every word under All, and only the kind’s under a Kind (C2-05)', () => {
    expect(outcomesOffered('all')).toEqual(CHECK_OUTCOMES);
    expect(outcomesOffered('goal')).toEqual([
      'pass',
      'fail',
      'error',
      'unavailable',
      'canceled',
      'indeterminate',
    ]);
    expect(outcomesOffered('scorer')).toEqual(outcomesOffered('goal'));
    expect(outcomesOffered('guardrail')).toEqual(['block', 'warn', 'sanitize', 'redact']);
    expect(outcomesOffered('tripwire')).toEqual(['tripwire']);
    expect(outcomesOffered('session')).toEqual(['tainted']);
  });
});

describe('the check in words', () => {
  test('takes a validator’s or a scorer’s name from before the last "@" and its version from after', () => {
    expect(splitCheckId('goal.attempt.validated', 'contains-phrase@3')).toEqual({
      name: 'contains-phrase',
      version: '3',
    });
    expect(splitCheckId('scorer.recorded', 'tone@weird@2')).toEqual({
      name: 'tone@weird',
      version: '2',
    });
    expect(splitCheckId('goal.attempt.validated', 'no-version')).toEqual({
      name: 'no-version',
      version: undefined,
    });
    expect(splitCheckId('goal.attempt.validated', 'trailing@')).toEqual({
      name: 'trailing',
      version: undefined,
    });
  });

  test('takes every other kind’s id whole, so an "@" in a guardrail’s name is not a version', () => {
    for (const kind of ['run.guardrail', 'run.tripwire', 'session.tainted'] as const) {
      expect(splitCheckId(kind, 'weird@name')).toEqual({ name: 'weird@name', version: undefined });
    }
  });

  test('titles a row as the goal pages say the check: a slug as words, a plugin prefix dropped', () => {
    expect(
      checkTitle({ kind: 'goal.attempt.validated', checkId: 'every-refund-is-listed@3' }),
    ).toBe('Every refund is listed');
    expect(checkTitle({ kind: 'goal.attempt.validated', checkId: 'demo:accepts-any@1' })).toBe(
      'Accepts any',
    );
    expect(checkTitle({ kind: 'run.tripwire', checkId: 'spend-limit' })).toBe('Spend limit');
    expect(checkTitle({ kind: 'session.tainted', checkId: 'prompt-injection' })).toBe(
      'Prompt injection',
    );
  });
});

describe('line two of a row (C2-09)', () => {
  test('reads the kind, the agent, and the version, in that order', () => {
    expect(
      checkLineTwo(checkFixture('1', { checkId: 'judge@3', agentName: 'tool-runner' }), agentLabel),
    ).toBe('Goal check, Tool runner, version 3');
  });

  test('puts a scorer’s score to two decimals before its version', () => {
    expect(
      checkLineTwo(
        checkFixture('1', {
          kind: 'scorer.recorded',
          checkId: 'politeness@2',
          agentName: 'tool-runner',
          score: 0.82,
        }),
        agentLabel,
      ),
    ).toBe('Scorer, Tool runner, score 0.82, version 2');
    expect(scoreText(1)).toBe('1.00');
    expect(scoreText(0)).toBe('0.00');
    expect(scoreText(0.8249)).toBe('0.82');
  });

  test('leaves the score out of a scorer row that has none, and every other kind’s', () => {
    expect(
      checkLineTwo(
        checkFixture('1', { kind: 'scorer.recorded', checkId: 'politeness@2', score: null }),
        agentLabel,
      ),
    ).toBe('Scorer, assistant, version 2');
    expect(
      checkLineTwo(
        checkFixture('1', { kind: 'run.guardrail', checkId: 'pii', outcome: 'block', score: 0.5 }),
        agentLabel,
      ),
    ).toBe('Guardrail, assistant');
  });

  test('leaves out an agent it cannot name, never reading "Unknown", and a version the id has none of', () => {
    const line = checkLineTwo(
      checkFixture('1', { kind: 'run.tripwire', checkId: 'spend-limit', agentName: null }),
      agentLabel,
    );
    expect(line).toBe('Tripwire');
    expect(line).not.toMatch(/unknown/i);
    expect(
      checkLineTwo(
        checkFixture('1', {
          kind: 'session.tainted',
          checkId: 'prompt-injection',
          agentName: 'tool-runner',
        }),
        agentLabel,
      ),
    ).toBe('Session, Tool runner');
  });

  test('names each kind in words, never its operation name', () => {
    const lines = (
      [
        'goal.attempt.validated',
        'run.guardrail',
        'run.tripwire',
        'scorer.recorded',
        'session.tainted',
      ] as const
    ).map((kind) =>
      checkLineTwo(checkFixture('1', { kind, checkId: 'x', agentName: null }), agentLabel),
    );
    expect(lines).toEqual(['Goal check', 'Guardrail', 'Tripwire', 'Scorer', 'Session']);
  });
});

describe('where a row leads (C2-14)', () => {
  test('is its goal when it has one, and its run otherwise', () => {
    expect(checkPath(checkFixture('1', { goalRunId: 'g-1', runId: 'r-1' }))).toBe('/goals/g-1');
    expect(checkPath(checkFixture('1', { goalRunId: null, runId: 'r-1' }))).toBe('/runs/r-1');
    // A flagged session names its run, not a chat.
    expect(
      checkPath(checkFixture('1', { kind: 'session.tainted', goalRunId: null, runId: 'run-7' })),
    ).toBe('/runs/run-7');
  });
});

describe('what the Check chip offers (C2-05)', () => {
  test('lists the checks of the rows loaded and the one applied, each once, as its words and version', () => {
    const rows = [
      checkFixture('1', { checkId: 'contains-phrase@3' }),
      checkFixture('2', { checkId: 'contains-phrase@3' }),
      checkFixture('3', { kind: 'run.guardrail', checkId: 'pii-input' }),
    ];
    expect(checkOptions(rows, 'old-check@1').map((option) => option.label)).toEqual([
      'Contains phrase, version 3',
      'Old check, version 1',
      'Pii input',
    ]);
    expect(checkOptions(rows, 'old-check@1').map((option) => option.value)).toEqual([
      'contains-phrase@3',
      'old-check@1',
      'pii-input',
    ]);
    expect(checkOptions(rows, 'pii-input')).toHaveLength(2);
    expect(checkOptions([], undefined)).toEqual([]);
  });
});
