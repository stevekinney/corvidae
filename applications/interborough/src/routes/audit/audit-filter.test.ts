import { describe, expect, test } from 'bun:test';

import {
  byWho,
  changeOf,
  draftFromSearch,
  EMPTY_AUDIT_DRAFT,
  filterOf,
  joinResource,
  pathOf,
  RESOURCE_KINDS,
  resourcePath,
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
    expect(
      filterOf({ since: '', type: ' schedule.created ', resource: ' schedule:s-1 ', who: '' }),
    ).toEqual({
      type: 'schedule.created',
      resource: 'schedule:s-1',
    });
  });

  test('round-trips through the address, and an empty search is the bare path', () => {
    const draft = {
      since: '2026-10-19T08:30',
      type: 'run.completed',
      resource: 'schedule:s 1',
      who: 'alice',
    };
    const path = pathOf(draft);
    expect(path.startsWith('/health/audit?')).toBe(true);
    expect(draftFromSearch(new URL(path, 'http://localhost').searchParams)).toEqual(draft);
    expect(pathOf(EMPTY_AUDIT_DRAFT)).toBe('/health/audit');
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

describe('Who', () => {
  const record = (principal: string | null) => ({
    sequence: 1,
    timestamp: '2026-10-19T08:00:00.000Z',
    type: 't',
    resource: 'r',
    principal,
    detail: null,
  });

  test('is held by the address and never sent to the Bureau', () => {
    const draft = { since: '', type: '', resource: '', who: ' alice ' };
    expect(filterOf(draft)).toEqual({});
    expect(pathOf(draft)).toBe('/health/audit?who=alice');
    expect(draftFromSearch(new URLSearchParams('who=alice'))).toEqual({
      ...EMPTY_AUDIT_DRAFT,
      who: 'alice',
    });
  });

  test('keeps the records one person did, all of them for no one, and none of the records with no actor', () => {
    const alice = record('alice');
    const records = [alice, record('bob'), record(null)];
    expect(byWho(records, 'alice')).toEqual([alice]);
    expect(byWho(records, ' ')).toEqual(records);
    expect(byWho(records, 'carol')).toEqual([]);
  });
});

describe('resourcePath', () => {
  test('is the page of the thing a resource names', () => {
    expect(resourcePath('session:abc')).toBe('/chats/abc');
    expect(resourcePath('agent:helper')).toBe('/agents/helper');
    expect(resourcePath('schedule:nightly')).toBe('/schedules/nightly');
    expect(resourcePath('workflow:order-processing')).toBe('/workflows/order-processing');
    expect(resourcePath('run-123')).toBe('/runs/run-123');
  });

  test('carries an identifier a path cannot, and names nothing for an empty resource or an empty id', () => {
    expect(resourcePath('session:new')).toBe('/chats/_?__weft_session_id=new');
    expect(resourcePath('')).toBeUndefined();
    expect(resourcePath('agent:')).toBeUndefined();
  });
});

describe('changeOf', () => {
  test('reads a value before and after, and leaves the other fields as they are', () => {
    expect(
      changeOf({ before: 'low', after: 'high', field: 'effort', attempts: 2, ok: true }),
    ).toEqual({
      before: 'low',
      after: 'high',
      rest: [
        ['field', 'effort'],
        ['attempts', '2'],
        ['ok', 'true'],
      ],
    });
  });

  test('has no change when the detail names neither, or there is no detail', () => {
    expect(changeOf({ status: 'completed' })).toEqual({
      before: undefined,
      after: undefined,
      rest: [['status', 'completed']],
    });
    expect(changeOf(null)).toEqual({ before: undefined, after: undefined, rest: [] });
  });

  test('reads one side alone', () => {
    expect(changeOf({ after: 'created' }).before).toBeUndefined();
    expect(changeOf({ after: 'created' }).after).toBe('created');
  });
});
