/**
 * A reason joined to a line by a comma starts in lower case, unless its first word is a proper
 * noun, an acronym or "I" (`reason-clause.ts`).
 */
import { describe, expect, test } from 'bun:test';

import { reasonClause } from './reason-clause.ts';

describe('reasonClause', () => {
  test('lower-cases a plain capitalised first word', () => {
    expect(reasonClause("The answer doesn't mention the staging fix")).toBe(
      "the answer doesn't mention the staging fix",
    );
    expect(reasonClause('Notes were over the length limit')).toBe(
      'notes were over the length limit',
    );
  });

  test('keeps a proper noun, an acronym, "I" and anything else as it is', () => {
    expect(reasonClause("GitHub didn't answer (HTTP 503)")).toBe("GitHub didn't answer (HTTP 503)");
    expect(reasonClause('HTTP 503 from the API')).toBe('HTTP 503 from the API');
    expect(reasonClause('I could not reach it')).toBe('I could not reach it');
    expect(reasonClause('A')).toBe('A');
    expect(reasonClause('3 of 4 refunds were listed')).toBe('3 of 4 refunds were listed');
    expect(reasonClause('  ')).toBe('');
  });
});
