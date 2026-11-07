import { describe, expect, test } from 'bun:test';

import { AUDIT_EVENT_TYPES } from '../../lib/audit-event-types.ts';
import {
  draftFromSearch,
  EMPTY_AUDIT_DRAFT,
  filterOf,
  isNarrowed,
  pathOf,
  periodStart,
  resourcePath,
  splitResource,
} from './audit-filter.ts';

const NOW = new Date('2026-11-02T10:46:00').getTime();
const DAY = 86_400_000;

describe('the audit filters', () => {
  test('a period starts at midnight today, or that many days back, or never', () => {
    expect(periodStart('today', NOW)).toBe(new Date('2026-11-02T00:00:00').getTime());
    expect(periodStart('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(periodStart('30d', NOW)).toBe(NOW - 30 * DAY);
    expect(periodStart('90d', NOW)).toBe(NOW - 90 * DAY);
    expect(periodStart('all', NOW)).toBeUndefined();
  });

  test('the Bureau is asked for the events of the action’s kind since the period began', () => {
    expect(filterOf(EMPTY_AUDIT_DRAFT, NOW)).toEqual({
      since: NOW - 7 * DAY,
      types: [...AUDIT_EVENT_TYPES],
    });
    expect(filterOf({ ...EMPTY_AUDIT_DRAFT, period: 'all', action: 'removed' }, NOW)).toEqual({
      types: ['tool.source.removed', 'provider.disconnected'],
    });
  });

  test('who and the search narrow nothing the Bureau is asked, and the default view is not a narrowing', () => {
    expect(filterOf({ ...EMPTY_AUDIT_DRAFT, actor: 'you', text: 'x' }, NOW)).toEqual(
      filterOf(EMPTY_AUDIT_DRAFT, NOW),
    );
    expect(isNarrowed(EMPTY_AUDIT_DRAFT)).toBe(false);
    expect(isNarrowed({ ...EMPTY_AUDIT_DRAFT, period: '30d' })).toBe(true);
    expect(isNarrowed({ ...EMPTY_AUDIT_DRAFT, text: ' ' })).toBe(false);
    expect(isNarrowed({ ...EMPTY_AUDIT_DRAFT, actor: 'agents' })).toBe(true);
  });

  test('round-trips through the address, a default is left out of it, and a value not offered is the default', () => {
    const draft = { actor: 'you', period: 'today', action: 'started', text: 'order 4471' } as const;
    const path = pathOf(draft, 'abc#1');
    expect(new URL(path, 'http://localhost').searchParams.get('record')).toBe('abc#1');
    expect(draftFromSearch(new URL(path, 'http://localhost').searchParams)).toEqual(draft);
    expect(pathOf(EMPTY_AUDIT_DRAFT)).toBe('/health/audit');
    expect(
      draftFromSearch(new URLSearchParams('actor=nobody&period=forever&action=exploded')),
    ).toEqual(EMPTY_AUDIT_DRAFT);
  });
});

describe('what a record is about', () => {
  test('reads a prefix as a kind, a bare id as a run, and the rest as nothing a page exists for', () => {
    expect(splitResource('schedule:s-1')).toEqual({ kind: 'schedule', id: 's-1' });
    expect(splitResource('session:c-2')).toEqual({ kind: 'session', id: 'c-2' });
    expect(splitResource('run-7')).toEqual({ kind: 'run', id: 'run-7' });
    expect(splitResource('provider:anthropic')).toEqual({
      kind: 'other',
      id: 'provider:anthropic',
    });
    expect(splitResource('host')).toEqual({ kind: 'other', id: 'host' });
    expect(splitResource('')).toEqual({ kind: 'other', id: '' });
  });

  test('names the page of what it is about', () => {
    expect(resourcePath('schedule:s-1')).toBe('/schedules/s-1');
    expect(resourcePath('agent:tool-runner')).toBe('/agents/tool-runner');
    expect(resourcePath('workflow:order-refund')).toBe('/workflows/order-refund');
    expect(resourcePath('session:c-2')).toBe('/chats/c-2');
    expect(resourcePath('run-abc')).toBe('/runs/run-abc');
    expect(resourcePath('provider:anthropic')).toBeUndefined();
    expect(resourcePath('')).toBeUndefined();
  });
});
