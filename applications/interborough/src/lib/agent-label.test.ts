/** What an agent is called where a person reads it: the catalog's name, in words when it is an identifier. */
import { describe, expect, test } from 'bun:test';

import { agentLabel } from './agent-label.ts';

const catalog = [
  { name: 'tool-runner', displayName: 'tool-runner' },
  { name: 'assistant', displayName: 'Assistant' },
  { name: 'demo:echo', displayName: 'demo:echo' },
];

describe('agentLabel', () => {
  test('reads an identifier-shaped display name in words', () => {
    expect(agentLabel('tool-runner', catalog)).toBe('Tool runner');
    expect(agentLabel('demo:echo', catalog)).toBe('Demo echo');
  });

  test('keeps a display name that is already prose', () => {
    expect(agentLabel('assistant', catalog)).toBe('Assistant');
  });

  test('falls back to the identifier, in words, where the catalog has none or is not loaded', () => {
    expect(agentLabel('release-helper', catalog)).toBe('Release helper');
    expect(agentLabel('release-helper', undefined)).toBe('Release helper');
  });
});
