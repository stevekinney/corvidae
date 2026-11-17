/**
 * The words of a check (design rows 68j and 68x, and the Checks page, COR-2114): the goal pages and
 * the Checks page name a check the same way, so one check has one name everywhere.
 */
import { describe, expect, test } from 'bun:test';

import { checkText } from './check-text.ts';

describe('the check of a goal', () => {
  test('reads a validator named by a slug as the words it stands for', () => {
    expect(checkText('every-refund-waiting-for-approval-is-listed')).toBe(
      'Every refund waiting for approval is listed',
    );
    expect(checkText('contains-phrase')).toBe('Contains phrase');
    expect(checkText('release_notes_name_the_fix')).toBe('Release notes name the fix');
  });

  test('leaves off the plugin a validator is namespaced under, as an agent’s row does', () => {
    expect(checkText('demo:accepts-any-answer')).toBe('Accepts any answer');
    expect(checkText('demo:never-passes', { phrase: 'hello' })).toBe('Never passes "hello"');
    // A name with a space, or with nothing after its colon, keeps its colon, as it always did.
    expect(checkText('Demo: reads well')).toBe('Demo: reads well');
    expect(checkText('demo:')).toBe('Demo:');
  });

  test('adds each top-level text and number of its configuration, in double quotes', () => {
    expect(checkText('contains-phrase', { phrase: 'staging fix' })).toBe(
      'Contains phrase "staging fix"',
    );
    expect(checkText('word-count', { minimum: 5, label: 'body', strict: true, tags: ['a'] })).toBe(
      'Word count "5", "body"',
    );
  });

  test('says nothing more for a configuration that holds no text or number, or is not an object', () => {
    for (const configuration of [
      null,
      undefined,
      [],
      {},
      'staging fix',
      7,
      { nested: { a: 'b' } },
    ]) {
      expect(checkText('contains-phrase', configuration), JSON.stringify(configuration)).toBe(
        'Contains phrase',
      );
    }
  });

  test('says a name that already has spaces as it is, and nothing for no name', () => {
    expect(checkText('Reply says hello')).toBe('Reply says hello');
    expect(checkText('  Reply says hello  ')).toBe('Reply says hello');
    expect(checkText('')).toBe('');
    expect(checkText('---')).toBe('---');
  });
});
