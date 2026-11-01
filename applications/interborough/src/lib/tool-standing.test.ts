/** When a tool asks first for an agent: the file's word, or the tier's default when it says nothing. */
import { describe, expect, test } from 'bun:test';

import { TOOL_APPROVALS } from './agent-definitions.ts';
import { standingOf } from './tool-standing.ts';

const reads = { defaultApproval: 'allow' } as const;
const changes = { defaultApproval: 'ask' } as const;

describe('standingOf', () => {
  test('follows the tier’s default when the file states nothing or on-changes', () => {
    for (const approval of [undefined, 'on-changes'] as const) {
      expect(standingOf(reads, approval)).toBe('runs');
      expect(standingOf(changes, approval)).toBe('asks-first');
    }
  });

  test('lets always and never replace the default, either way', () => {
    expect(standingOf(reads, 'always')).toBe('asks-first');
    expect(standingOf(changes, 'never')).toBe('runs');
  });

  test('reads blocked as refused, whatever the default', () => {
    expect(standingOf(reads, 'blocked')).toBe('blocked');
    expect(standingOf(changes, 'blocked')).toBe('blocked');
  });

  test('answers every approval the file can state', () => {
    for (const approval of TOOL_APPROVALS) {
      expect(['asks-first', 'runs', 'blocked']).toContain(standingOf(changes, approval));
    }
  });
});
