import { describe, expect, test } from 'bun:test';

import { oneLine } from './one-line.ts';

const AGENT_FAILURE =
  'Agent "assistant" failed (finish reason "error"): {"name":"AgentRunError","message":"GitHub didn’t answer (HTTP 503)","kind":"generate","code":"UNKNOWN","cause":{"name":"Error","message":"GitHub didn’t answer (HTTP 503)"}}';

describe('oneLine', () => {
  test('reads the cause an agent run wraps in its own message, without the detail in parentheses', () => {
    expect(oneLine(AGENT_FAILURE)).toBe('GitHub didn’t answer');
  });

  test('keeps the detail in parentheses when asked, as the Runs list does', () => {
    expect(oneLine(AGENT_FAILURE, { keepParenthetical: true })).toBe(
      'GitHub didn’t answer (HTTP 503)',
    );
  });

  test('drops the name of the error class and everything after the first line', () => {
    expect(oneLine('TypeError: Cannot read properties\n    at run (file.ts:1:1)')).toBe(
      'Cannot read properties',
    );
  });

  test('reads a message whose brace is not JSON as it stands', () => {
    expect(oneLine('Expected { after the key')).toBe('Expected { after the key');
  });

  test('keeps the text of a message that is only a parenthetical', () => {
    expect(oneLine('(nothing else)')).toBe('');
  });
});
