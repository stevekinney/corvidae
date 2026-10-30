/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import type { ScheduleFire, ScheduleValue } from './schedule-builder.types.ts';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: ScheduleBuilder } = await import('./schedule-builder.svelte');

/** A cron no Repeats choice produces, so the builder opens on Custom cron. */
const CUSTOM_CRON: ScheduleValue = { cron: '0 9 1-7 * *', timeZone: 'UTC' };

const STATIC_FIRES: ScheduleFire[] = [
  { id: 'fire-1', label: 'Mon Jun 1, 09:00' },
  { id: 'fire-2', label: 'Tue Jun 2, 09:00' },
];

function stubComputeNextFires(fires: ScheduleFire[] = STATIC_FIRES) {
  return mock((_value: ScheduleValue, _count: number) => fires);
}

type LabelQuery = (text: string) => HTMLElement;

/** Chooses a Repeats option the way the native select reports it. */
async function chooseRepeats(getByLabelText: LabelQuery, repeats: string): Promise<void> {
  await fireEvent.change(getByLabelText('Repeats'), { target: { value: repeats } });
}

function readBack(container: Element): string | null | undefined {
  return container.querySelector('.cinder-schedule-builder__summary-text')?.textContent?.trim();
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ScheduleBuilder', () => {
  describe('structure', () => {
    test('renders the cinder-schedule-builder root with a default label', () => {
      const { container } = render(ScheduleBuilder, {});
      const root = container.querySelector('.cinder-schedule-builder');
      expect(root).not.toBeNull();
      expect(root?.getAttribute('aria-label')).toBe('Schedule');
      expect(root?.getAttribute('role')).toBe('group');
    });

    test('merges a custom class onto the root element', () => {
      const { container } = render(ScheduleBuilder, { class: 'my-schedule' });
      const root = container.querySelector('.cinder-schedule-builder');
      expect(root?.classList.contains('my-schedule')).toBe(true);
    });

    test('honors a custom label prop', () => {
      const { container } = render(ScheduleBuilder, { label: 'Job schedule' });
      const root = container.querySelector('.cinder-schedule-builder');
      expect(root?.getAttribute('aria-label')).toBe('Job schedule');
    });

    test('allows a consumer aria-labelledby to take precedence over the default label', () => {
      const { container } = render(ScheduleBuilder, {
        'aria-labelledby': 'external-heading',
      } as never);
      const root = container.querySelector('.cinder-schedule-builder');
      expect(root?.getAttribute('aria-labelledby')).toBe('external-heading');
      expect(root?.getAttribute('aria-label')).toBeNull();
    });

    test('normalizes an empty or whitespace-only aria-label to the label default', () => {
      for (const ariaLabel of ['', '   ']) {
        const { container } = render(ScheduleBuilder, { 'aria-label': ariaLabel } as never);
        const root = container.querySelector('.cinder-schedule-builder');
        expect(root?.getAttribute('aria-label')).toBe('Schedule');
        cleanup();
      }
    });

    test('normalizes an empty aria-labelledby so it is omitted rather than rendered empty', () => {
      const { container } = render(ScheduleBuilder, { 'aria-labelledby': '' } as never);
      const root = container.querySelector('.cinder-schedule-builder');
      expect(root?.hasAttribute('aria-labelledby')).toBe(false);
      expect(root?.getAttribute('aria-label')).toBe('Schedule');
    });

    test('an omitted value opens on every day at 9:00 AM in the browser time zone', () => {
      const { container, getByLabelText } = render(ScheduleBuilder, {});

      expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe('daily');
      expect(requiredInstance(getByLabelText('At'), HTMLInputElement).value).toBe('09:00');
      // The package's test script runs under TZ=UTC.
      expect(readBack(container)).toBe('Every day at 9:00 AM UTC');
    });

    test('Repeats offers the settled choices in order', () => {
      const { getByLabelText } = render(ScheduleBuilder, {});
      const select = requiredInstance(getByLabelText('Repeats'), HTMLSelectElement);

      expect(Array.from(select.options, (option) => option.textContent?.trim())).toEqual([
        'Every day',
        'Weekdays',
        'Weekends',
        'Custom days',
        'Monthly on a day',
        'Every few minutes or hours',
        'Custom cron',
      ]);
    });
  });

  describe('repeats', () => {
    test('each choice emits its cron and reads back as a sentence', async () => {
      const cases: { repeats: string; cron: string; readBack: string }[] = [
        { repeats: 'weekdays', cron: '0 9 * * 1-5', readBack: 'Weekdays at 9:00 AM Pacific Time' },
        { repeats: 'weekends', cron: '0 9 * * 0,6', readBack: 'Weekends at 9:00 AM Pacific Time' },
        {
          repeats: 'custom-days',
          cron: '0 9 * * 0,1,2,3,4,5,6',
          readBack: 'Every day at 9:00 AM Pacific Time',
        },
        {
          repeats: 'monthly',
          cron: '0 9 1 * *',
          readBack: 'Monthly on the 1st at 9:00 AM Pacific Time',
        },
        { repeats: 'cron', cron: '0 9 * * *', readBack: 'Every day at 9:00 AM Pacific Time' },
      ];
      for (const expected of cases) {
        const onValueChange = mock();
        const { container, getByLabelText } = render(ScheduleBuilder, {
          value: { cron: '0 9 * * *', timeZone: 'America/Los_Angeles' },
          onValueChange,
        });

        await chooseRepeats(getByLabelText, expected.repeats);

        expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
          cron: expected.cron,
          timeZone: 'America/Los_Angeles',
        });
        expect(readBack(container)).toBe(expected.readBack);
        cleanup();
      }
    });

    test('Every 7 hours emits the interval value, not a cron, and hides At', async () => {
      const onValueChange = mock();
      const { container, getByLabelText, queryByLabelText } = render(ScheduleBuilder, {
        onValueChange,
      });

      await chooseRepeats(getByLabelText, 'interval');
      expect(queryByLabelText('At')).toBeNull();
      await fireEvent.input(getByLabelText('Every'), { target: { value: '7' } });
      await fireEvent.blur(getByLabelText('Every'));

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        every: { unit: 'hours', count: 7 },
        timeZone: 'UTC',
      });
      expect(readBack(container)).toBe('Every 7 hours');
    });

    test('the interval unit switches between minutes and hours only', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, {
        value: { every: { unit: 'hours', count: 2 }, timeZone: 'UTC' },
        onValueChange,
      });
      const unit = requiredInstance(getByLabelText('Unit'), HTMLSelectElement);

      expect(Array.from(unit.options, (option) => option.value)).toEqual(['minutes', 'hours']);
      await fireEvent.change(unit, { target: { value: 'minutes' } });

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        every: { unit: 'minutes', count: 2 },
        timeZone: 'UTC',
      });
    });

    test('At changes the time a choice runs at', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'weekdays');
      await fireEvent.change(requiredInstance(getByLabelText('At'), HTMLInputElement), {
        target: { value: '14:30' },
      });

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '30 14 * * 1-5',
        timeZone: 'UTC',
      });
      expect(readBack(container)).toBe('Weekdays at 2:30 PM UTC');
    });

    test('clearing At keeps the prior time instead of silently becoming midnight', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });
      const timeInput = requiredInstance(getByLabelText('At'), HTMLInputElement);

      await fireEvent.change(timeInput, { target: { value: '09:15' } });
      onValueChange.mockClear();
      // A real clear fires `input` before `change`.
      await fireEvent.input(timeInput, { target: { value: '' } });
      await fireEvent.change(timeInput, { target: { value: '' } });

      expect(onValueChange).not.toHaveBeenCalled();
      expect(readBack(container)).toBe('Every day at 9:15 AM UTC');
      expect(timeInput.value).toBe('09:15');
    });

    test('Custom days starts from the previous days and toggles one segmented day group', async () => {
      const onValueChange = mock();
      const { container, getByLabelText, getByRole } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 1-5', timeZone: 'UTC' },
        onValueChange,
      });

      await chooseRepeats(getByLabelText, 'custom-days');
      const group = getByRole('group', { name: 'Days of week' });
      expect(group).not.toBeNull();
      expect(getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true');
      expect(getByRole('button', { name: 'Sunday' }).getAttribute('aria-pressed')).toBe('false');

      await fireEvent.click(getByRole('button', { name: 'Tuesday' }));
      await fireEvent.click(getByRole('button', { name: 'Thursday' }));

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '0 9 * * 1,3,5',
        timeZone: 'UTC',
      });
      expect(readBack(container)).toBe('Mondays, Wednesdays and Fridays at 9:00 AM UTC');
    });

    test('Custom days cannot clear its last day', async () => {
      const onValueChange = mock();
      const { getByRole } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 3', timeZone: 'UTC' },
        onValueChange,
      });

      const wednesday = getByRole('button', { name: 'Wednesday' });
      await fireEvent.click(wednesday);

      expect(wednesday.getAttribute('aria-pressed')).toBe('true');
      expect(onValueChange).not.toHaveBeenCalled();
    });

    test('Monthly on a day emits the day of month', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'monthly');
      await fireEvent.input(getByLabelText('Day of month'), { target: { value: '22' } });
      await fireEvent.blur(getByLabelText('Day of month'));

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '0 9 22 * *',
        timeZone: 'UTC',
      });
      expect(readBack(container)).toBe('Monthly on the 22nd at 9:00 AM UTC');
    });

    test('a custom cron that matches a choice reopens as that choice', () => {
      const cases: { cron: string; repeats: string }[] = [
        { cron: '0 9 * * *', repeats: 'daily' },
        { cron: '0 9 * * 1,2,3,4,5', repeats: 'weekdays' },
        { cron: '0 9 * * 6,0', repeats: 'weekends' },
        { cron: '30 14 * * 2,4', repeats: 'custom-days' },
        { cron: '0 8 15 * *', repeats: 'monthly' },
        { cron: '0 */6 * * *', repeats: 'cron' },
      ];
      for (const expected of cases) {
        const { container, getByLabelText } = render(ScheduleBuilder, {
          value: { cron: expected.cron, timeZone: 'UTC' },
        });
        expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe(
          expected.repeats,
        );
        expect(container.querySelector(`[data-sb-repeats="${expected.repeats}"]`)).not.toBeNull();
        cleanup();
      }
    });

    test('Custom cron starts from the expression the previous choice lowered to', async () => {
      const { getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '15 7 * * 0,6', timeZone: 'UTC' },
      });

      await chooseRepeats(getByLabelText, 'cron');

      expect(requiredInstance(getByLabelText('Minute'), HTMLInputElement).value).toBe('15');
      expect(requiredInstance(getByLabelText('Hour'), HTMLInputElement).value).toBe('7');
      expect(requiredInstance(getByLabelText('Day of week'), HTMLInputElement).value).toBe('0,6');
    });

    test('re-choosing the current Repeats option emits nothing', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'daily');

      expect(onValueChange).not.toHaveBeenCalled();
    });
  });

  describe('time zone', () => {
    test('choosing a zone sets timeZone and the read-back names it', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 1-5', timeZone: 'UTC' },
        timeZones: ['UTC', 'America/Los_Angeles', 'Europe/London'],
        onValueChange,
      });
      const input = requiredInstance(getByLabelText('Time zone'), HTMLInputElement);

      input.focus();
      await fireEvent.input(input, { target: { value: 'los_angeles' } });
      let option: Element | undefined;
      await waitFor(() => {
        option = Array.from(document.body.querySelectorAll('[role="option"]')).find((element) =>
          element.textContent?.includes('America/Los Angeles'),
        );
        expect(option).toBeDefined();
      });
      await fireEvent.mouseDown(option!);

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '0 9 * * 1-5',
        timeZone: 'America/Los_Angeles',
      });
      expect(readBack(container)).toBe('Weekdays at 9:00 AM Pacific Time');
    });

    test('a value zone outside the offered list is still offered', () => {
      const { getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'Asia/Tokyo' },
        timeZones: ['UTC'],
      });

      expect(requiredInstance(getByLabelText('Time zone'), HTMLInputElement).value).toBe(
        'Asia/Tokyo',
      );
    });
  });

  describe('controlled value resync', () => {
    test('a post-mount value change re-seeds the fields and read-back', async () => {
      const { container, getByLabelText, rerender } = render(ScheduleBuilder, {
        value: { every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' },
      });
      expect(readBack(container)).toBe('Every 15 minutes');

      await rerender({ value: { cron: '0 9 * * 1', timeZone: 'UTC' } });

      expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe(
        'custom-days',
      );
      expect(readBack(container)).toBe('Mondays at 9:00 AM UTC');
    });

    test('re-passing the emitted value (a controlled echo) does not reset a mid-edit cron field', async () => {
      const onValueChange = mock();
      const { getByLabelText, rerender } = render(ScheduleBuilder, {
        value: CUSTOM_CRON,
        onValueChange,
      });

      const minuteField = requiredInstance(getByLabelText('Minute'), HTMLInputElement);
      await fireEvent.input(minuteField, { target: { value: '9' } });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      const echoed: ScheduleValue = { ...(onValueChange.mock.calls[0]![0] as ScheduleValue) };

      await rerender({ value: echoed, onValueChange });

      expect(minuteField.value).toBe('9');
      expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe('cron');
    });

    test('an uncontrolled builder does not reset a mid-edit cron field on re-render', async () => {
      const { getByLabelText, rerender } = render(ScheduleBuilder, {});

      await chooseRepeats(getByLabelText, 'cron');
      await fireEvent.input(getByLabelText('Minute'), { target: { value: '5' } });
      await rerender({});

      expect(requiredInstance(getByLabelText('Minute'), HTMLInputElement).value).toBe('5');
    });

    test('a parent that rejects an edit by re-passing the prior value reverts the field', async () => {
      const onValueChange = mock();
      const { getByLabelText, rerender } = render(ScheduleBuilder, {
        value: CUSTOM_CRON,
        onValueChange,
      });

      const minuteField = requiredInstance(getByLabelText('Minute'), HTMLInputElement);
      await fireEvent.input(minuteField, { target: { value: '30' } });
      expect(onValueChange).toHaveBeenCalledTimes(1);

      await rerender({ value: { ...CUSTOM_CRON }, onValueChange });

      expect(requiredInstance(getByLabelText('Minute'), HTMLInputElement).value).toBe('0');
    });

    test('a controlled value change to undefined resets to the default', async () => {
      const { container, getByLabelText, rerender } = render(ScheduleBuilder, {
        value: { every: { unit: 'hours', count: 3 }, timeZone: 'UTC' },
      });

      await rerender({ value: undefined });

      expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe('daily');
      expect(readBack(container)).toBe('Every day at 9:00 AM UTC');
    });
  });

  describe('accessibility', () => {
    test('Repeats and Unit are native selects with labels', async () => {
      const { getByLabelText } = render(ScheduleBuilder, {});
      expect(getByLabelText('Repeats').tagName).toBe('SELECT');
      await chooseRepeats(getByLabelText, 'interval');
      expect(getByLabelText('Unit').tagName).toBe('SELECT');
    });

    test('the time zone is a combobox', () => {
      const { getByRole } = render(ScheduleBuilder, { timeZones: ['UTC'] });
      expect(getByRole('combobox', { name: 'Time zone' })).not.toBeNull();
    });

    test('the read-back announces changes politely', () => {
      const { container } = render(ScheduleBuilder, {});
      expect(
        container
          .querySelector('.cinder-schedule-builder__summary-text')
          ?.getAttribute('aria-live'),
      ).toBe('polite');
    });

    test('day chips are native buttons with aria-pressed (guarantees Enter/Space activation)', async () => {
      const { getByLabelText, getByRole } = render(ScheduleBuilder, {});
      await chooseRepeats(getByLabelText, 'custom-days');
      const chip = getByRole('button', { name: 'Monday' });
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.hasAttribute('aria-pressed')).toBe(true);
    });
  });

  describe('custom cron', () => {
    test('composes Grid through its public component entry', async () => {
      const source = await Bun.file(
        new URL('./schedule-builder-cron-editor.svelte', import.meta.url),
      ).text();

      expect(source).toContain("import { default as Grid } from '../grid/index.ts'");
      expect(source).not.toContain("from '../grid/grid.svelte'");
    });

    test('offers structured every, specific, range, and step controls with raw cron as an escape hatch', async () => {
      const onValueChange = mock();
      const { getByLabelText, getAllByRole } = render(ScheduleBuilder, {
        value: CUSTOM_CRON,
        onValueChange,
      });

      expect(getByLabelText('Minute pattern')).not.toBeNull();
      expect(getAllByRole('option', { name: 'Every value (*)' })).not.toHaveLength(0);
      expect(getAllByRole('option', { name: 'Specific value' })).not.toHaveLength(0);
      expect(getAllByRole('option', { name: 'Range' })).not.toHaveLength(0);
      expect(getAllByRole('option', { name: 'Step (every N)' })).not.toHaveLength(0);
      expect(getAllByRole('option', { name: 'Advanced raw expression' })).not.toHaveLength(0);

      const minuteRawExpression = requiredInstance(getByLabelText('Minute'), HTMLInputElement);
      expect(
        requiredInstance(minuteRawExpression.closest('details'), HTMLDetailsElement).open,
      ).toBe(false);
      expect(minuteRawExpression.getAttribute('data-cinder-variant')).toBe('code');

      await fireEvent.change(getByLabelText('Minute pattern'), {
        target: { value: 'advanced' },
      });
      expect(
        requiredInstance(minuteRawExpression.closest('details'), HTMLDetailsElement).open,
      ).toBe(true);

      await fireEvent.change(getByLabelText('Minute pattern'), { target: { value: 'step' } });
      await fireEvent.input(getByLabelText('Minute step'), { target: { value: '15' } });
      await fireEvent.blur(getByLabelText('Minute step'));
      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '*/15 9 1-7 * *',
        timeZone: 'UTC',
      });
    });

    test('switches the field to advanced mode when the raw expression is edited', async () => {
      const onValueChange = mock();
      const { getByLabelText, queryByLabelText } = render(ScheduleBuilder, {
        value: CUSTOM_CRON,
        onValueChange,
      });

      await fireEvent.change(getByLabelText('Minute pattern'), {
        target: { value: 'specific' },
      });
      await fireEvent.input(getByLabelText('Minute'), { target: { value: '*/10' } });

      expect(requiredInstance(getByLabelText('Minute pattern'), HTMLSelectElement).value).toBe(
        'advanced',
      );
      expect(queryByLabelText('Minute value', { exact: true })).toBeNull();
      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '*/10 9 1-7 * *',
        timeZone: 'UTC',
      });
    });

    test('shows range validation on the visible structured controls without a duplicate alert', () => {
      const { getAllByText, queryByRole } = render(ScheduleBuilder, {
        value: { cron: '40-10 * * * *', timeZone: 'UTC' },
      });
      expect(getAllByText('Range start is after its end.').length).toBeGreaterThan(0);
      expect(queryByRole('alert')).toBeNull();
    });

    test('a valid cron field edit commits a joined cron expression via onValueChange', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'cron');
      const minuteField = requiredInstance(getByLabelText('Minute'), HTMLInputElement);
      await fireEvent.input(minuteField, { target: { value: '30' } });

      expect(onValueChange.mock.calls.at(-1)![0]).toEqual({ cron: '30 9 * * *', timeZone: 'UTC' });
    });

    test('an out-of-range cron field surfaces an inline error and does not call onValueChange', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'cron');
      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });

      expect(hourField.getAttribute('aria-invalid')).toBe('true');
      const describedBy = hourField.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const errorNode = document.getElementById(
        describedBy!.split(' ').find((id) => id.includes('error')) ?? '',
      );
      expect(errorNode?.textContent).toBe('Out of range (0–23).');
      expect(onValueChange).toHaveBeenCalledTimes(1);
    });

    test('correcting an invalid cron field back to valid resumes emitting onValueChange', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'cron');
      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });
      expect(onValueChange).toHaveBeenCalledTimes(1);

      await fireEvent.input(hourField, { target: { value: '10' } });
      expect(onValueChange).toHaveBeenCalledTimes(2);
      expect(onValueChange.mock.calls[1]![0]).toEqual({ cron: '0 10 * * *', timeZone: 'UTC' });
    });

    test('cron field description carries its numeric hint', async () => {
      const { getByLabelText } = render(ScheduleBuilder, {});

      await chooseRepeats(getByLabelText, 'cron');

      const minuteField = requiredInstance(getByLabelText('Minute'), HTMLInputElement);
      const describedBy = minuteField.getAttribute('aria-describedby') ?? '';
      const hintId = describedBy.split(' ')[0] ?? '';
      expect(document.getElementById(hintId)?.textContent).toBe('0–59');
    });
  });

  describe('next-fires preview', () => {
    test('is hidden entirely when computeNextFires is absent', () => {
      const { container } = render(ScheduleBuilder, {});
      expect(container.querySelector('.cinder-schedule-builder__preview')).toBeNull();
    });

    test('does not crash when computeNextFires is absent and fields change', async () => {
      const { container, getByLabelText } = render(ScheduleBuilder, {});
      await chooseRepeats(getByLabelText, 'cron');
      expect(container.querySelector('.cinder-schedule-builder')).not.toBeNull();
    });

    test('renders fires returned from an injected computeNextFires', () => {
      const computeNextFires = stubComputeNextFires();
      const { container, getAllByRole } = render(ScheduleBuilder, { computeNextFires });

      expect(computeNextFires).toHaveBeenCalled();
      const [calledValue, calledCount] = computeNextFires.mock.calls[0]!;
      expect(calledValue).toEqual({ cron: '0 9 * * *', timeZone: 'UTC' });
      expect(calledCount).toBe(5);

      const items = getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        'Mon Jun 1, 09:00',
        'Tue Jun 2, 09:00',
      ]);
      expect(container.querySelector('.cinder-schedule-builder__preview')).not.toBeNull();
    });

    test('shows an empty state when computeNextFires returns no fires', () => {
      const computeNextFires = stubComputeNextFires([]);
      const { container } = render(ScheduleBuilder, { computeNextFires });

      expect(container.querySelector('.cinder-schedule-builder__preview-list')).toBeNull();
      expect(container.textContent).toContain('No upcoming runs.');
    });

    test('passes a custom previewCount through to computeNextFires', () => {
      const computeNextFires = stubComputeNextFires();
      render(ScheduleBuilder, { computeNextFires, previewCount: 3 });

      expect(computeNextFires.mock.calls[0]![1]).toBe(3);
    });

    test('normalizes a fractional, zero, negative, or NaN previewCount to a positive integer before calling computeNextFires', async () => {
      const computeNextFires = stubComputeNextFires();
      const { rerender } = render(ScheduleBuilder, { computeNextFires, previewCount: 0 });
      expect(computeNextFires.mock.calls[0]![1]).toBe(5);

      await rerender({ computeNextFires, previewCount: 2.5 });
      expect(computeNextFires.mock.calls.at(-1)![1]).toBe(5);

      await rerender({ computeNextFires, previewCount: -3 });
      expect(computeNextFires.mock.calls.at(-1)![1]).toBe(5);

      await rerender({ computeNextFires, previewCount: Number.NaN });
      expect(computeNextFires.mock.calls.at(-1)![1]).toBe(5);

      // A genuinely valid previewCount still passes through unnormalized.
      await rerender({ computeNextFires, previewCount: 7 });
      expect(computeNextFires.mock.calls.at(-1)![1]).toBe(7);
    });

    test('does not call computeNextFires while a cron field is invalid, and shows an unavailable message', async () => {
      const computeNextFires = stubComputeNextFires();
      const { container, getByLabelText } = render(ScheduleBuilder, {
        computeNextFires,
      });

      await chooseRepeats(getByLabelText, 'cron');
      computeNextFires.mockClear();

      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });

      expect(computeNextFires).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        'Preview unavailable — fix the cron expression above.',
      );
      expect(container.querySelector('.cinder-schedule-builder__preview-list')).toBeNull();
    });

    test('resumes calling computeNextFires once the cron field is corrected back to valid', async () => {
      const computeNextFires = stubComputeNextFires();
      const { getByLabelText } = render(ScheduleBuilder, { computeNextFires });

      await chooseRepeats(getByLabelText, 'cron');
      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });
      computeNextFires.mockClear();

      await fireEvent.input(hourField, { target: { value: '10' } });

      expect(computeNextFires).toHaveBeenCalledTimes(1);
      expect(computeNextFires.mock.calls[0]![0]).toEqual({ cron: '0 10 * * *', timeZone: 'UTC' });
    });

    test('degrades to an unavailable message instead of crashing when computeNextFires throws', () => {
      const computeNextFires = mock(() => {
        throw new Error('boom');
      });
      const { container } = render(ScheduleBuilder, { computeNextFires });

      expect(container.querySelector('.cinder-schedule-builder')).not.toBeNull();
      expect(container.textContent).toContain('Preview unavailable.');
      expect(container.querySelector('.cinder-schedule-builder__preview-list')).toBeNull();
    });
  });

  describe('CSS snapshot', () => {
    test('CSS file exists, is non-empty, and declares its cascade layer', async () => {
      const { readFileSync } = await import('node:fs');
      const css = readFileSync(new URL('./schedule-builder.css', import.meta.url), 'utf8');
      expect(css).toContain('cinder-schedule-builder');
      expect(css).toContain('@layer cinder.components');
    });

    test('aggregates Grid styles before the component layer', async () => {
      const { readFileSync } = await import('node:fs');
      const css = readFileSync(new URL('./schedule-builder.css', import.meta.url), 'utf8');
      expect(css.indexOf('@layer cinder.tokens')).toBeLessThan(
        css.indexOf("@import '../grid/grid.css'"),
      );
      expect(css.indexOf("@import '../grid/grid.css'")).toBeLessThan(
        css.indexOf('@layer cinder.components'),
      );
    });

    test('uses the standard rotating chevron for raw cron disclosures', async () => {
      const [componentSource, cssSource] = await Promise.all([
        Bun.file(new URL('./schedule-builder-cron-editor.svelte', import.meta.url)).text(),
        Bun.file(new URL('./schedule-builder.css', import.meta.url)).text(),
      ]);

      expect(componentSource).toContain('ChevronDown');
      expect(componentSource).toContain('cinder-schedule-builder__cron-advanced-chevron');
      expect(cssSource).toMatch(
        /\.cinder-schedule-builder__cron-advanced\[open\][\s\S]*?transform:\s*rotate\(180deg\)/,
      );
    });
  });
});
