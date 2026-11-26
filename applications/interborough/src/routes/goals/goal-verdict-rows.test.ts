/**
 * What an attempt's verdict panel says (COR-2124): the facts of a verdict the Bureau gave, and which
 * words a verdict it could not read gets, by who is looking.
 */
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft/testing';
import { GOALS_COPY } from '../../app/copy/goals.ts';
import { configurationIssuesOf } from './goal-form-failure.ts';
import { verdictFacts, verdictFailure, verdictWord } from './goal-verdict-rows.ts';

const copy = GOALS_COPY.detail.verdict;

const JUDGE = {
  validator: { name: 'contains-phrase', version: '1' },
  source: { kind: 'plugin', name: 'checks', version: '2.3.4' },
  configuration: { phrase: 'staging fix' },
} as const;

describe('the facts of a verdict', () => {
  test('say the check in words with the settings it was given, and its name, version and plugin beneath', () => {
    expect(
      verdictFacts({
        reason: null,
        error: null,
        validator: { name: 'checks:contains-phrase', version: '1' },
        configuration: { phrase: 'staging fix' },
        judgedBy: {
          ...JUDGE,
          validator: { name: 'checks:contains-phrase', version: '1' },
        },
      }),
    ).toEqual([
      {
        term: 'Check',
        definition: 'Contains phrase "staging fix"',
        // Where it comes from, without the plugin's release.
        note: 'checks:contains-phrase, version 1, from the Checks plugin',
      },
    ]);
  });

  test('say a built-in check is built in, and say nothing of the Bureau’s release', () => {
    const facts = verdictFacts({
      reason: null,
      error: null,
      validator: { name: 'check', version: '1' },
      configuration: null,
      judgedBy: {
        validator: { name: 'check', version: '1' },
        source: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
        configuration: null,
      },
    });
    expect(facts[0]).toEqual({
      term: 'Check',
      definition: 'Check',
      note: 'check, version 1, built in',
    });
  });

  test('say a validator the owner wrote as a file is their own', () => {
    const facts = verdictFacts({
      reason: null,
      error: null,
      validator: { name: 'staging-notes', version: 'abc' },
      configuration: null,
      judgedBy: {
        validator: { name: 'staging-notes', version: 'abc' },
        source: { kind: 'bungalow', name: 'bungalow', version: 'abc' },
        configuration: null,
      },
    });
    expect(facts[0]?.note).toBe('staging-notes, version abc, from your own validator file');
  });

  test('put the detail of an error or unavailable verdict first, and name only the validator for a record written before the judge was kept', () => {
    const facts = verdictFacts({
      reason: null,
      error: { kind: 'load', code: 'VALIDATOR_MISSING', message: 'The validator is gone.' },
      validator: { name: 'check', version: '1' },
      configuration: null,
      judgedBy: null,
    });
    expect(facts.map((fact) => fact.term)).toEqual(['Detail', 'Check']);
    expect(facts[0]?.definition).toBe('The validator is gone.');
    expect(facts[1]).toEqual({ term: 'Check', definition: 'Check', note: 'check, version 1' });
  });

  test('never say a pass’s reason as a detail of what the check could not do (row 67v)', () => {
    const facts = verdictFacts({
      outcome: 'pass',
      reason: 'Reply said hello',
      error: null,
      validator: { name: 'check', version: '1' },
      configuration: null,
      judgedBy: null,
    });
    expect(facts.map((fact) => fact.term)).toEqual(['Check']);
  });
});

describe('the word a verdict opens with', () => {
  test('is the word an attempt’s row says for a pass and a miss, and its own for every other kind', () => {
    expect(verdictWord('pass')).toBe('Done');
    expect(verdictWord('fail')).toBe('Check not met');
    const own = (['error', 'unavailable', 'indeterminate', 'canceled'] as const).map(verdictWord);
    expect(own).toEqual([
      'Check not met, check error',
      'Unavailable, check could not run',
      'Check not met, could not decide',
      'Canceled, check stopped',
    ]);
    // Each of the six is a different phrase.
    expect(new Set([verdictWord('pass'), verdictWord('fail'), ...own]).size).toBe(6);
  });
});

describe('a verdict that could not be read', () => {
  test('is private to a viewer who is not the owner, and not judged yet to the owner', () => {
    expect(verdictFailure('NotFound', { owner: 'alice', viewer: 'bob' })).toMatchObject({
      reason: 'private',
      title: copy.privateTitle,
    });
    expect(verdictFailure('NotFound', { owner: 'alice', viewer: 'alice' })).toMatchObject({
      reason: 'not-judged',
      title: copy.notJudgedTitle,
    });
  });

  test('is not judged yet for a host that names no principal, which is the local owner', () => {
    for (const viewer of [undefined, null]) {
      expect(verdictFailure('NotFound', { owner: 'anonymous:local', viewer }).reason).toBe(
        'not-judged',
      );
    }
  });

  test('is unreadable for any other fault, whoever is looking', () => {
    expect(verdictFailure('Unavailable', { owner: 'alice', viewer: 'bob' })).toMatchObject({
      reason: 'unreadable',
      tone: 'warning',
    });
    expect(verdictFailure(undefined, { owner: 'alice', viewer: 'alice' }).reason).toBe(
      'unreadable',
    );
  });
});

describe('the fields of a check’s configuration a fault names', () => {
  const fault = (code: string, issues: unknown) =>
    new HttpClientError(400, 'Bad Request', { data: { weftCode: code, issues } });

  test('are the issues under validator.configuration, by their path inside it', () => {
    expect(
      configurationIssuesOf(
        fault('InvalidParams', [
          { path: ['validator', 'configuration', 'phrase'], message: 'Too short' },
          { path: ['validator', 'configuration'], message: 'Takes none' },
          { path: ['goal'], message: 'Not about it' },
          { path: ['validator', 'name'], message: 'Not about it either' },
        ]),
      ),
    ).toEqual([
      { path: ['phrase'], message: 'Too short' },
      { path: [], message: 'Takes none' },
    ]);
  });

  test('are none for another fault, an error that is not a fault, and issues of the wrong shape', () => {
    expect(
      configurationIssuesOf(fault('Unprocessable', [{ path: ['validator'], message: 'x' }])),
    ).toEqual([]);
    expect(configurationIssuesOf(new Error('nope'))).toEqual([]);
    expect(configurationIssuesOf(fault('InvalidParams', 'not a list'))).toEqual([]);
    expect(
      configurationIssuesOf(fault('InvalidParams', [null, { path: 'x', message: 1 }])),
    ).toEqual([]);
  });
});
