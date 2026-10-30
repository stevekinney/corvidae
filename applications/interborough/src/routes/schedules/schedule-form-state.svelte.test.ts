import { describe, expect, test } from 'bun:test';

import {
  inputJsonError,
  jitterError,
  ScheduleFormState,
  scheduleIdError,
} from './schedule-form-state.svelte.ts';

describe('scheduleIdError', () => {
  test('an empty id is valid — means auto-generate', () => {
    expect(scheduleIdError('')).toBeUndefined();
  });

  test('a normal id is valid', () => {
    expect(scheduleIdError('nightly-rollup')).toBeUndefined();
  });

  test('rejects an id over 128 characters', () => {
    expect(scheduleIdError('a'.repeat(129))).toBe('Must be at most 128 characters.');
  });

  test('accepts an id at exactly the 128 character limit', () => {
    expect(scheduleIdError('a'.repeat(128))).toBeUndefined();
  });

  test('rejects an id containing a control character', () => {
    expect(scheduleIdError(`bad${String.fromCharCode(7)}id`)).toBe(
      'Must not contain control characters.',
    );
  });
});

describe('jitterError', () => {
  test('an empty jitter string is valid — means no jitter', () => {
    expect(jitterError('')).toBeUndefined();
    expect(jitterError('   ')).toBeUndefined();
  });

  test('accepts every documented duration unit', () => {
    for (const value of ['30s', '5m', '1h', '250ms', '2 days', '1.5h']) {
      expect(jitterError(value)).toBeUndefined();
    }
  });

  test('rejects an unrecognized format', () => {
    expect(jitterError('soon')).toBe('Use a duration like "30s", "5m", or "1h".');
    expect(jitterError('5')).toBe('Use a duration like "30s", "5m", or "1h".');
  });
});

describe('inputJsonError', () => {
  test('accepts valid JSON, including the empty object', () => {
    expect(inputJsonError('{}')).toBeUndefined();
    expect(inputJsonError('{"warehouseId":"wh-1"}')).toBeUndefined();
    expect(inputJsonError('null')).toBeUndefined();
  });

  test('rejects malformed JSON', () => {
    expect(inputJsonError('{not json')).toBe('Must be valid JSON.');
  });
});

describe('ScheduleFormState', () => {
  test('defaults to an empty, invalid draft (no workflow type chosen)', () => {
    const form = new ScheduleFormState();
    expect(form.workflowType).toBe('');
    expect(form.inputText).toBe('{}');
    expect(form.overlap).toBe('skip');
    expect(form.cadence).toEqual({ every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' });
    expect(form.revisionPolicy).toBe('active-at-fire');
    expect(form.initialRevisionPolicy).toBe('active-at-fire');
    expect(form.isValid).toBe(false);
    expect(form.errors.workflowType).toBe('Choose a workflow type.');
  });

  test('applies every field from an init snapshot', () => {
    const form = new ScheduleFormState({
      id: 'nightly-rollup',
      workflowType: 'report-gen',
      inputText: '{"day":"today"}',
      cadence: { cron: '0 2 * * *', timeZone: 'UTC' },
      overlap: 'queue',
      jitterText: '30s',
      backfill: true,
      startPaused: true,
      revisionPolicy: 'pinned',
    });

    expect(form.id).toBe('nightly-rollup');
    expect(form.workflowType).toBe('report-gen');
    expect(form.inputText).toBe('{"day":"today"}');
    expect(form.cadence).toEqual({ cron: '0 2 * * *', timeZone: 'UTC' });
    expect(form.overlap).toBe('queue');
    expect(form.jitterText).toBe('30s');
    expect(form.backfill).toBe(true);
    expect(form.startPaused).toBe(true);
    expect(form.revisionPolicy).toBe('pinned');
    expect(form.initialRevisionPolicy).toBe('pinned');
    expect(form.isValid).toBe(true);
  });

  test('is invalid when any single field is invalid', () => {
    const form = new ScheduleFormState({ workflowType: 'report-gen', inputText: '{bad' });
    expect(form.isValid).toBe(false);
    expect(form.errors.input).toBe('Must be valid JSON.');
    expect(form.errors.workflowType).toBeUndefined();
  });

  test('parsedInput reflects the current inputText, undefined when invalid', () => {
    const form = new ScheduleFormState({ workflowType: 'report-gen' });
    form.inputText = '{"warehouseId":"wh-1"}';
    expect(form.parsedInput).toEqual({ warehouseId: 'wh-1' });

    form.inputText = 'not json';
    expect(form.parsedInput).toBeUndefined();
  });

  describe('toCreateArgs', () => {
    test('omits id and jitter when both are blank', () => {
      const form = new ScheduleFormState({
        workflowType: 'report-gen',
        cadence: { cron: '0 2 * * *', timeZone: 'UTC' },
      });

      expect(form.toCreateArgs()).toEqual({
        workflowType: 'report-gen',
        input: {},
        spec: { cron: '0 2 * * *' },
        timeZone: 'UTC',
        overlap: 'skip',
        backfill: false,
        revisionPolicy: 'active-at-fire',
      });
    });

    test('includes a trimmed id and jitter when both are set', () => {
      const form = new ScheduleFormState({
        workflowType: 'report-gen',
        id: '  nightly-rollup  ',
        jitterText: '  30s  ',
        cadence: { every: { unit: 'minutes', count: 5 }, timeZone: 'UTC' },
        overlap: 'cancel-running',
        backfill: true,
      });

      expect(form.toCreateArgs()).toEqual({
        workflowType: 'report-gen',
        input: {},
        spec: { every: 300_000 },
        overlap: 'cancel-running',
        backfill: true,
        revisionPolicy: 'active-at-fire',
        id: 'nightly-rollup',
        jitter: '30s',
      });
    });

    test('includes a non-default revisionPolicy from init', () => {
      const form = new ScheduleFormState({
        workflowType: 'report-gen',
        cadence: { cron: '0 2 * * *', timeZone: 'UTC' },
        revisionPolicy: 'pinned',
      });

      expect(form.toCreateArgs().revisionPolicy).toBe('pinned');
    });
  });

  describe('toUpdateRevisionPolicy', () => {
    test('returns undefined when unchanged from the initial policy (active-at-fire)', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen' });
      expect(form.toUpdateRevisionPolicy()).toBeUndefined();
    });

    test('returns undefined when unchanged from the initial policy (pinned)', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen', revisionPolicy: 'pinned' });
      expect(form.toUpdateRevisionPolicy()).toBeUndefined();
    });

    test('returns the new value when switched from active-at-fire to pinned', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen' });
      form.revisionPolicy = 'pinned';
      expect(form.toUpdateRevisionPolicy()).toBe('pinned');
    });

    test('returns the new value when switched from pinned to active-at-fire', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen', revisionPolicy: 'pinned' });
      form.revisionPolicy = 'active-at-fire';
      expect(form.toUpdateRevisionPolicy()).toBe('active-at-fire');
    });

    test('returns undefined again if switched away and back to the initial value', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen' });
      form.revisionPolicy = 'pinned';
      form.revisionPolicy = 'active-at-fire';
      expect(form.toUpdateRevisionPolicy()).toBeUndefined();
    });
  });
  describe('description', () => {
    test('defaults to empty and is forwarded by toCreateArgs only when non-blank', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen' });
      expect(form.description).toBe('');
      expect(form.toCreateArgs()).not.toHaveProperty('description');
      form.description = '  Nightly rollup  ';
      expect(form.toCreateArgs().description).toBe('Nightly rollup');
    });
  });

  describe('toUpdateOptions (COR-15: omit-when-unchanged for every editable option)', () => {
    const loaded = {
      workflowType: 'report-gen',
      description: 'Nightly rollup',
      overlap: 'skip',
      jitterText: '30000ms',
      backfill: false,
      revisionPolicy: 'active-at-fire',
    } as const;

    test('returns undefined when nothing changed, so a cadence-only edit resends nothing', () => {
      expect(new ScheduleFormState(loaded).toUpdateOptions()).toBeUndefined();
    });

    test('includes only the description when only it changed', () => {
      const form = new ScheduleFormState(loaded);
      form.description = 'Weekly rollup';
      expect(form.toUpdateOptions()).toEqual({ description: 'Weekly rollup' });
    });

    test('includes only the overlap policy when only it changed', () => {
      const form = new ScheduleFormState(loaded);
      form.overlap = 'queue';
      expect(form.toUpdateOptions()).toEqual({ overlap: 'queue' });
    });

    test('includes only backfill when only it changed', () => {
      const form = new ScheduleFormState(loaded);
      form.backfill = true;
      expect(form.toUpdateOptions()).toEqual({ backfill: true });
    });

    test('includes only the trimmed jitter when only it changed', () => {
      const form = new ScheduleFormState(loaded);
      form.jitterText = ' 5m ';
      expect(form.toUpdateOptions()).toEqual({ jitter: '5m' });
    });

    test('includes revisionPolicy alongside the others when it changed', () => {
      const form = new ScheduleFormState(loaded);
      form.revisionPolicy = 'pinned';
      form.backfill = true;
      expect(form.toUpdateOptions()).toEqual({ backfill: true, revisionPolicy: 'pinned' });
    });

    test('a value switched away and back is omitted again', () => {
      const form = new ScheduleFormState(loaded);
      form.overlap = 'queue';
      form.overlap = 'skip';
      expect(form.toUpdateOptions()).toBeUndefined();
    });

    test('clearing a jitter that was set is a validation error (the engine cannot unset it)', () => {
      const form = new ScheduleFormState(loaded);
      form.jitterText = '';
      expect(form.errors.jitter).toBe(
        'Jitter can be changed but not removed once set — enter a new duration.',
      );
      expect(form.isValid).toBe(false);
    });
  });

  describe('isDirty', () => {
    test('is false for a fresh edit draft and true after any editable field changes', () => {
      const form = new ScheduleFormState({ workflowType: 'report-gen' });
      expect(form.isDirty).toBe(false);
      form.revisionPolicy = 'pinned';
      expect(form.isDirty).toBe(true);
    });
  });
});

describe('a cadence the builder cannot show exactly', () => {
  const builderValue = { every: { unit: 'minutes', count: 1 }, timeZone: 'UTC' } as const;

  test('is kept as stored until the operator changes it, and then follows the builder', () => {
    const form = new ScheduleFormState({
      cadence: builderValue,
      originalCadence: { intervalMs: 30_000 },
    });
    expect(form.exactCadenceText).toBe('Every 30 seconds');
    expect(form.cadenceSpec).toEqual({ every: 30_000 });
    expect(form.isDirty).toBe(false);

    form.changeCadence();
    expect(form.exactCadenceText).toBeUndefined();
    expect(form.cadenceSpec).toEqual({ every: 60_000 });
    expect(form.isDirty).toBe(true);
  });

  test('is replaced by a cadence the builder commits', () => {
    const form = new ScheduleFormState({
      cadence: builderValue,
      originalCadence: { intervalMs: 90_000 },
    });
    form.setCadence({ every: { unit: 'minutes', count: 5 }, timeZone: 'UTC' });
    expect(form.cadenceChanged).toBe(true);
    expect(form.cadenceSpec).toEqual({ every: 300_000 });
  });

  test('is not special for a whole-minute interval or a cron expression, which the builder shows exactly', () => {
    const minutes = new ScheduleFormState({
      cadence: { every: { unit: 'minutes', count: 5 }, timeZone: 'UTC' },
      originalCadence: { intervalMs: 300_000 },
    });
    expect(minutes.exactCadenceText).toBeUndefined();
    expect(minutes.cadenceSpec).toEqual({ every: 300_000 });
    const cron = new ScheduleFormState({
      cadence: { cron: '0 9 * * *', timeZone: 'UTC' },
      originalCadence: { cronExpression: '0 9 * * *' },
    });
    expect(cron.exactCadenceText).toBeUndefined();
    expect(cron.cadenceSpec).toEqual({ cron: '0 9 * * *' });
  });

  test('a new draft has no original cadence, so it sends what the builder holds', () => {
    const form = new ScheduleFormState({
      cadence: { every: { unit: 'hours', count: 2 }, timeZone: 'UTC' },
    });
    expect(form.exactCadenceText).toBeUndefined();
    expect(form.toCreateArgs().spec).toEqual({ every: 7_200_000 });
  });
});

describe('the time zone a cron cadence is read in', () => {
  test('a new cron schedule is created in the zone the builder chose', () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      cadence: { cron: '0 9 * * 1-5', timeZone: 'America/Los_Angeles' },
    });
    expect(form.toCreateArgs()).toMatchObject({
      spec: { cron: '0 9 * * 1-5' },
      timeZone: 'America/Los_Angeles',
    });
  });

  test('a new interval schedule is created without a zone, which Weft refuses for one', () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      cadence: { every: { unit: 'hours', count: 7 }, timeZone: 'America/Los_Angeles' },
    });
    const args = form.toCreateArgs();
    expect(args.spec).toEqual({ every: 25_200_000 });
    expect(args).not.toHaveProperty('timeZone');
  });

  test('an edit sends the zone only when it changed, and a zone-only change is dirty', () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      cadence: { cron: '0 9 * * *', timeZone: 'Europe/London' },
      originalCadence: { cronExpression: '0 9 * * *', timeZone: 'Europe/London' },
    });
    expect(form.toUpdateOptions()).toBeUndefined();
    expect(form.isDirty).toBe(false);

    form.setCadence({ cron: '0 9 * * *', timeZone: 'Asia/Tokyo' });

    expect(form.isDirty).toBe(true);
    expect(form.toUpdateOptions()).toEqual({ timeZone: 'Asia/Tokyo' });
  });

  test('an edit from an interval to a cron sends the zone, even UTC', () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      cadence: { every: { unit: 'hours', count: 1 }, timeZone: 'UTC' },
      originalCadence: { intervalMs: 3_600_000, timeZone: 'UTC' },
    });
    form.setCadence({ cron: '0 9 * * *', timeZone: 'UTC' });
    expect(form.toUpdateOptions()).toEqual({ timeZone: 'UTC' });
  });
});
