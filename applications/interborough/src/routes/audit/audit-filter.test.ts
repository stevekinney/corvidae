import { describe, expect, test } from 'bun:test';

import {
  draftFromSearch,
  EMPTY_AUDIT_DRAFT,
  filterOf,
  joinResource,
  pathOf,
  RESOURCE_KINDS,
  sinceOf,
  splitResource,
} from './audit-filter.ts';

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
    expect(filterOf({ since: '', type: ' schedule.created ', resource: ' schedule:s-1 ' })).toEqual(
      {
        type: 'schedule.created',
        resource: 'schedule:s-1',
      },
    );
  });

  test('round-trips through the address, and an empty search is the bare path', () => {
    const draft = { since: '2026-10-19T08:30', type: 'run.completed', resource: 'schedule:s 1' };
    const path = pathOf(draft);
    expect(path.startsWith('/audit?')).toBe(true);
    expect(draftFromSearch(new URL(path, 'http://localhost').searchParams)).toEqual(draft);
    expect(pathOf(EMPTY_AUDIT_DRAFT)).toBe('/audit');
  });
});

describe('the resource picker', () => {
  test('builds the kind:<id> string, so the prefix is never typed', () => {
    expect(joinResource({ kind: 'schedule', id: 's-1' })).toBe('schedule:s-1');
    expect(joinResource({ kind: 'session', id: ' c-2 ' })).toBe('session:c-2');
    expect(joinResource({ kind: 'agent', id: 'echo' })).toBe('agent:echo');
    expect(joinResource({ kind: 'workflow', id: 'order-processing' })).toBe(
      'workflow:order-processing',
    );
    expect(joinResource({ kind: 'run', id: 'run-7' })).toBe('run-7');
  });

  test('a kind with no id, or an id with no kind, narrows nothing', () => {
    expect(joinResource({ kind: 'schedule', id: '  ' })).toBe('');
    expect(joinResource({ kind: '', id: 's-1' })).toBe('');
  });

  test('reads a resource string back into the kind and id it was built from', () => {
    for (const { kind } of RESOURCE_KINDS) {
      expect(splitResource(joinResource({ kind, id: 'some-id' })), kind).toEqual({
        kind,
        id: 'some-id',
      });
    }
    expect(splitResource('')).toEqual({ kind: '', id: '' });
    expect(splitResource('  schedule:s-1 ')).toEqual({ kind: 'schedule', id: 's-1' });
  });

  test('keeps a resource the picker has no kind for, as a run id, so it still reads back unchanged', () => {
    const odd = 'memory:m-1';
    const choice = splitResource(odd);
    expect(choice).toEqual({ kind: 'run', id: odd });
    expect(joinResource(choice)).toBe(odd);
  });
});
