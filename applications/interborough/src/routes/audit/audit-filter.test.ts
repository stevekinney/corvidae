import { describe, expect, test } from 'bun:test';

import { draftFromSearch, EMPTY_AUDIT_DRAFT, filterOf, pathOf, sinceOf } from './audit-filter.ts';

describe('the audit filter', () => {
  test('reads a local time as epoch milliseconds, and nothing else as a time', () => {
    expect(sinceOf('2026-10-19T08:30')).toBe(new Date('2026-10-19T08:30').getTime());
    expect(sinceOf('2026-10-19T08:30:15')).toBe(new Date('2026-10-19T08:30:15').getTime());
    for (const text of ['', 'yesterday', '2026-10-19', '2026-13-45T99:99']) {
      expect(sinceOf(text), text).toBeUndefined();
    }
  });

  test('sends only what is set, trimmed, and the resource under the name the Bureau takes it by', () => {
    expect(filterOf(EMPTY_AUDIT_DRAFT)).toEqual({});
    expect(filterOf({ since: '', type: ' schedule.created ', resource: ' schedule:s-1 ' })).toEqual({
      type: 'schedule.created',
      resource: 'schedule:s-1',
    });
  });

  test('round-trips through the address, and an empty search is the bare path', () => {
    const draft = { since: '2026-10-19T08:30', type: 'run.completed', resource: 'schedule:s 1' };
    const path = pathOf(draft);
    expect(path.startsWith('/audit?')).toBe(true);
    expect(draftFromSearch(new URL(path, 'http://localhost').searchParams)).toEqual(draft);
    expect(pathOf(EMPTY_AUDIT_DRAFT)).toBe('/audit');
  });
});
