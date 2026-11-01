import { describe, expect, test } from 'bun:test';

import { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';

const BUILDER_VALUE = { every: { unit: 'minutes', count: 1 }, timeZone: 'UTC' } as const;

describe('AgentScheduleFormState cadence', () => {
  test('an edit resends a cadence below a minute exactly until the operator changes it', () => {
    const form = new AgentScheduleFormState({
      cadence: BUILDER_VALUE,
      originalCadence: { intervalMs: 30_000 },
      description: 'Every thirty seconds',
      revision: 2,
    });
    expect(form.exactCadenceText).toBe('Every 30 seconds');
    expect(form.toUpdate()).toEqual({ spec: '30s' });
    expect(form.isDirty).toBe(false);

    form.description = 'Edited';
    expect(form.toUpdate()).toEqual({ spec: '30s', description: 'Edited' });

    form.changeCadence();
    expect(form.exactCadenceText).toBeUndefined();
    expect(form.toUpdate().spec).toBe('1m');
  });

  test('a cadence the builder commits replaces the kept one', () => {
    const form = new AgentScheduleFormState({
      cadence: BUILDER_VALUE,
      originalCadence: { intervalMs: 90_000 },
      revision: 1,
    });
    expect(form.spec).toBe('90s');
    form.setCadence({ every: { unit: 'minutes', count: 20 }, timeZone: 'UTC' });
    expect(form.spec).toBe('20m');
  });

  test('keeps a cron expression and a whole-minute interval as they were', () => {
    const cron = new AgentScheduleFormState({
      cadence: { cron: '0 9 * * *', timeZone: 'UTC' },
      originalCadence: { cronExpression: '0 9 * * *' },
      revision: 1,
    });
    expect(cron.spec).toBe('0 9 * * *');
    expect(cron.exactCadenceText).toBeUndefined();
    const hours = new AgentScheduleFormState({
      cadence: { every: { unit: 'hours', count: 6 }, timeZone: 'UTC' },
      originalCadence: { intervalMs: 21_600_000 },
      revision: 1,
    });
    expect(hours.spec).toBe('6h');
    expect(hours.exactCadenceText).toBeUndefined();
  });
});

describe('AgentScheduleFormState time zone', () => {
  test('an edit sends the zone only when it changed', () => {
    const form = new AgentScheduleFormState({
      cadence: { cron: '0 9 * * *', timeZone: 'Europe/London' },
      originalCadence: { cronExpression: '0 9 * * *', timeZone: 'Europe/London' },
      revision: 1,
    });
    expect(form.toUpdate()).toEqual({ spec: '0 9 * * *' });
    expect(form.isDirty).toBe(false);

    form.setCadence({ cron: '0 9 * * *', timeZone: 'Asia/Tokyo' });

    expect(form.isDirty).toBe(true);
    expect(form.toUpdate()).toEqual({ spec: '0 9 * * *', timeZone: 'Asia/Tokyo' });
  });
});
