import { describe, expect, test } from 'bun:test';

import { readBuilder, setScheduleFields } from './workflow-builder-model.ts';
import { scheduleFieldsOf, scheduleValueOf } from './workflow-schedule-value.ts';

const RELEASE_NOTES = `${JSON.stringify(
  {
    name: 'release-notes',
    trigger: {
      kind: 'schedule',
      name: 'Release notes digest',
      spec: '0 11 * * 5',
      timezone: 'America/Chicago',
      overlap: 'skip',
      catchUp: false,
      input: { branch: 'main' },
    },
    steps: [],
  },
  null,
  2,
)}\n`;

describe('COR-2432: a schedule trigger as the When block edits it (rows 65d, 65q)', () => {
  test('the builder reads the zone, the overlap, catch-up and the name from the file', () => {
    expect(readBuilder(RELEASE_NOTES)?.trigger).toEqual({
      kind: 'schedule',
      spec: '0 11 * * 5',
      timezone: 'America/Chicago',
      overlap: 'skip',
      catchUp: false,
      name: 'Release notes digest',
    });
  });

  test('a cron is read in its zone, UTC when the file names none, and an interval of minutes or hours has none', () => {
    expect(scheduleValueOf({ spec: '0 11 * * 5', timezone: 'America/Chicago' })).toEqual({
      cron: '0 11 * * 5',
      timeZone: 'America/Chicago',
    });
    expect(scheduleValueOf({ spec: '0  9 * * 1-5', timezone: null })).toEqual({
      cron: '0 9 * * 1-5',
      timeZone: 'UTC',
    });
    expect(scheduleValueOf({ spec: '15m', timezone: null })).toEqual({
      every: { unit: 'minutes', count: 15 },
      timeZone: 'UTC',
    });
    expect(scheduleValueOf({ spec: '24h', timezone: null })).toEqual({
      every: { unit: 'hours', count: 24 },
      timeZone: 'UTC',
    });
  });

  test('a spec the builder cannot draw stays a field', () => {
    expect(scheduleValueOf({ spec: '', timezone: null })).toBeUndefined();
    expect(scheduleValueOf({ spec: '30s', timezone: null })).toBeUndefined();
    expect(scheduleValueOf({ spec: '1h30m', timezone: null })).toBeUndefined();
  });

  test('what the block emits is written as the spec and the zone, and an interval drops the zone', () => {
    expect(scheduleFieldsOf({ cron: '0 9 * * 1-5', timeZone: 'America/Chicago' })).toEqual({
      spec: '0 9 * * 1-5',
      timezone: 'America/Chicago',
    });
    expect(
      scheduleFieldsOf({ every: { unit: 'hours', count: 2 }, timeZone: 'America/Chicago' }),
    ).toEqual({ spec: '2h', timezone: null });
  });

  test('a write keeps every other key of the trigger where it is', () => {
    const next = setScheduleFields(RELEASE_NOTES, { spec: '0 11 * * 1', overlap: 'allow' });
    const trigger = (JSON.parse(next) as { trigger: Record<string, unknown> }).trigger;
    expect(Object.keys(trigger)).toEqual([
      'kind',
      'name',
      'spec',
      'timezone',
      'overlap',
      'catchUp',
      'input',
    ]);
    expect(trigger['spec']).toBe('0 11 * * 1');
    expect(trigger['overlap']).toBe('allow');
    const interval = setScheduleFields(RELEASE_NOTES, { spec: '2h', timezone: null });
    expect(JSON.parse(interval).trigger).not.toHaveProperty('timezone');
  });

  test('text whose trigger is not a schedule is left as it is', () => {
    const signal = JSON.stringify({ name: 'x', trigger: { kind: 'signal', name: 'go' } });
    expect(setScheduleFields(signal, { spec: '1h' })).toBe(signal);
  });
});
