/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import type { ScheduleFire, ScheduleValue } from './schedule-builder.types.ts';
import { availableTimeZones } from './schedule-builder.utilities.ts';

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
      expect(requiredInstance(getByLabelText('At'), HTMLInputElement).value).toBe('9:00 AM');
      // The package's test script runs under TZ=UTC.
      expect(readBack(container)).toBe('Every day at 9:00 AM UTC.');
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
        { repeats: 'weekdays', cron: '0 9 * * 1-5', readBack: 'Weekdays at 9:00 AM Pacific time.' },
        { repeats: 'weekends', cron: '0 9 * * 0,6', readBack: 'Weekends at 9:00 AM Pacific time.' },
        {
          repeats: 'custom-days',
          cron: '0 9 * * 0,1,2,3,4,5,6',
          readBack: 'Every day at 9:00 AM Pacific time.',
        },
        {
          repeats: 'monthly',
          cron: '0 9 1 * *',
          readBack: 'Monthly on the 1st at 9:00 AM Pacific time.',
        },
        { repeats: 'cron', cron: '0 9 * * *', readBack: 'Every day at 9:00 AM Pacific time.' },
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
      expect(readBack(container)).toBe('Every 7 hours.');
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
        target: { value: '2:30 pm' },
      });

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '30 14 * * 1-5',
        timeZone: 'UTC',
      });
      expect(readBack(container)).toBe('Weekdays at 2:30 PM UTC.');
    });

    test('clearing At keeps the prior time instead of silently becoming midnight', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });
      const timeInput = requiredInstance(getByLabelText('At'), HTMLInputElement);

      await fireEvent.change(timeInput, { target: { value: '9:15 AM' } });
      onValueChange.mockClear();
      // A real clear fires `input` before `change`.
      await fireEvent.input(timeInput, { target: { value: '' } });
      await fireEvent.change(timeInput, { target: { value: '' } });

      expect(onValueChange).not.toHaveBeenCalled();
      expect(readBack(container)).toBe('Every day at 9:15 AM UTC.');
      expect(timeInput.value).toBe('9:15 AM');
    });

    test('At is a text field that reads 9:00 AM, with no browser time control or clock glyph (rows 74d 74s)', () => {
      const { getByLabelText } = render(ScheduleBuilder, {});
      const at = requiredInstance(getByLabelText('At'), HTMLInputElement);
      expect(at.type).toBe('text');
      expect(at.value).toBe('9:00 AM');
    });

    test('At leaves a time it cannot read as it was, and says nothing was changed', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });
      const at = requiredInstance(getByLabelText('At'), HTMLInputElement);
      await fireEvent.input(at, { target: { value: 'noonish' } });
      await fireEvent.change(at, { target: { value: 'noonish' } });
      expect(onValueChange).not.toHaveBeenCalled();
      expect(at.value).toBe('9:00 AM');
      expect(readBack(container)).toBe('Every day at 9:00 AM UTC.');
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
      expect(readBack(container)).toBe('Monday, Wednesday and Friday at 9:00 AM UTC.');
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
      expect(readBack(container)).toBe('Monthly on the 22nd at 9:00 AM UTC.');
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
    function trigger(container: Element): HTMLButtonElement {
      return requiredInstance(
        container.querySelector('button[role="combobox"]'),
        HTMLButtonElement,
      );
    }

    async function openZones(container: Element): Promise<HTMLInputElement> {
      await fireEvent.click(trigger(container));
      let search: HTMLInputElement | null = null;
      await waitFor(() => {
        search = document.body.querySelector<HTMLInputElement>('.cinder-combobox__search input');
        if (!search) throw new Error('search field has not mounted');
      });
      return search!;
    }

    function rows(): string[] {
      return Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      );
    }

    test('the closed field reads the zone as its name and city', () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
      });
      expect(trigger(container).textContent?.trim()).toBe('Central time · Chicago');
    });

    test("the open list is a searchable picker with each row's offset at its edge", async () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
      });
      const search = await openZones(container);

      expect(search.getAttribute('placeholder')).toBe('Search time zones');
      expect(rows()).toHaveLength(5);
      expect(rows()[0]).toContain('Central time · Chicago');
      expect(rows()[1]).toContain('Central time · Mexico City');
      expect(rows()[2]).toContain('Pacific time · Los Angeles');
      expect(rows()[3]).toContain('Mountain time · Denver');
      expect(rows()[4]).toContain('UTC');
      expect(
        Array.from(document.body.querySelectorAll('.cinder-schedule-builder__offset')).map(
          (element) => element.textContent,
        ),
      ).toEqual(expect.arrayContaining(['UTC\u22126', 'UTC\u22128', 'UTC\u22127', 'UTC±0']));
    });

    test('the footer counts every zone and tells the person to type', async () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
      });
      await openZones(container);
      const total = availableTimeZones().length;
      expect(
        document.body.querySelector('.cinder-schedule-builder__time-zone-footer')?.textContent,
      ).toBe(`Showing 5 of ${total} zones. Type to narrow.`);
    });

    test('the footer drops its advice once every match is listed', async () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'UTC' },
        timeZones: ['UTC', 'America/Los_Angeles', 'Europe/London'],
      });
      await openZones(container);
      expect(
        document.body.querySelector('.cinder-schedule-builder__time-zone-footer')?.textContent,
      ).toBe('Showing 3 of 3 zones.');
    });

    test('choosing a zone sets timeZone and the read-back names it', async () => {
      const onValueChange = mock();
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 1-5', timeZone: 'UTC' },
        timeZones: ['UTC', 'America/Los_Angeles', 'Europe/London'],
        onValueChange,
      });
      const search = await openZones(container);

      await fireEvent.input(search, { target: { value: 'los_angeles' } });
      let option: Element | undefined;
      await waitFor(() => {
        option = Array.from(document.body.querySelectorAll('[role="option"]')).find((element) =>
          element.textContent?.includes('Los Angeles'),
        );
        expect(option).toBeDefined();
      });
      await fireEvent.mouseDown(option!);

      expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual({
        cron: '0 9 * * 1-5',
        timeZone: 'America/Los_Angeles',
      });
      expect(readBack(container)).toBe('Weekdays at 9:00 AM Pacific time.');
    });

    test('a name finds every zone that carries it', async () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
      });
      const search = await openZones(container);
      await fireEvent.input(search, { target: { value: 'mexico' } });
      await waitFor(() => expect(rows()[0]).toContain('Mexico City'));
    });

    test('a value zone outside the offered list is still offered', () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'Asia/Tokyo' },
        timeZones: ['UTC'],
      });

      expect(trigger(container).textContent).toContain('Tokyo');
    });

    test('an interval has no time zone to choose', async () => {
      const { container, getByLabelText, queryByText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
      });
      await chooseRepeats(getByLabelText, 'interval');

      expect(container.querySelector('button[role="combobox"]')).toBeNull();
      expect(queryByText('Time zone')).toBeNull();
    });
  });

  describe('interval', () => {
    const interval: ScheduleValue = {
      every: { unit: 'hours', count: 2 },
      timeZone: 'America/Chicago',
    };

    test('shows Every and Unit with the line that says no zone applies, and hides At and Time zone', () => {
      const { container, getByLabelText, queryByLabelText, getByText } = render(ScheduleBuilder, {
        value: interval,
      });

      expect(requiredInstance(getByLabelText('Every'), HTMLInputElement).value).toBe('2');
      expect(requiredInstance(getByLabelText('Unit'), HTMLSelectElement).value).toBe('hours');
      expect(
        getByText('An interval counts from when you create it, so no time zone applies.'),
      ).not.toBeNull();
      expect(queryByLabelText('At')).toBeNull();
      expect(container.querySelector('button[role="combobox"]')).toBeNull();
    });

    test('reads back without a zone and counts the next runs from creation', () => {
      const { container, getByText } = render(ScheduleBuilder, {
        value: interval,
        computeNextFires: stubComputeNextFires([
          { id: 'a', label: '2 hours after you create it' },
          { id: 'b', label: '4 hours after' },
        ]),
      });

      expect(readBack(container)).toBe('Every 2 hours.');
      expect(getByText('Next runs · counting from when you create it')).not.toBeNull();
      expect(
        Array.from(container.querySelectorAll('.cinder-schedule-builder__preview-item')).map(
          (item) => item.textContent,
        ),
      ).toEqual(['2 hours after you create it', '4 hours after']);
    });

    test('a time of day keeps the plain Next runs heading', () => {
      const { getByText, queryByText } = render(ScheduleBuilder, {
        computeNextFires: stubComputeNextFires(),
      });
      expect(getByText('Next runs')).not.toBeNull();
      expect(queryByText(/counting from/)).toBeNull();
    });
  });

  describe('runs panel', () => {
    test('one inset panel holds the sentence and the next runs', () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'America/Chicago' },
        computeNextFires: stubComputeNextFires(),
      });
      const panel = requiredInstance(
        container.querySelector('.cinder-schedule-builder__panel'),
        HTMLElement,
      );

      expect(
        panel.querySelector('.cinder-schedule-builder__summary-text')?.textContent?.trim(),
      ).toBe('Every day at 9:00 AM Central time.');
      expect(panel.querySelector('.cinder-schedule-builder__preview-list')).not.toBeNull();
      expect(panel.textContent).toContain('Runs');
      expect(panel.textContent).toContain('Next runs');
      expect(container.querySelectorAll('.cinder-schedule-builder__panel')).toHaveLength(1);
    });

    test('Custom days names its days in full, Monday first', async () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 5,1,3', timeZone: 'America/Chicago' },
      });
      expect(readBack(container)).toBe('Monday, Wednesday and Friday at 9:00 AM Central time.');
    });

    test('Monthly names the day and the zone', () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 1 * *', timeZone: 'America/Los_Angeles' },
      });
      expect(readBack(container)).toBe('Monthly on the 1st at 9:00 AM Pacific time.');
    });

    test('Custom days sits in one joined group beside At', async () => {
      const { container, getByRole } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 1,3,5', timeZone: 'America/Chicago' },
      });
      const row = requiredInstance(
        container.querySelector('[data-cinder-fields="primary"]'),
        HTMLElement,
      );
      const group = getByRole('group', { name: 'Days of week' });

      expect(row.contains(group)).toBe(true);
      expect(
        Array.from(group.querySelectorAll('button'), (button) => button.textContent?.trim()),
      ).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
      expect(
        Array.from(group.querySelectorAll('button')).map((button) =>
          button.getAttribute('aria-pressed'),
        ),
      ).toEqual(['true', 'false', 'true', 'false', 'true', 'false', 'false']);
    });
  });

  describe('policies', () => {
    test('draws no policy select unless one is given', () => {
      const { container } = render(ScheduleBuilder, {});
      expect(container.querySelector('.cinder-schedule-builder__policies')).toBeNull();
    });

    test('draws the overlap and catch-up selects side by side after the Runs panel', () => {
      const { container, getByLabelText } = render(ScheduleBuilder, {
        overlap: 'skip',
        catchUp: false,
        overlapLabel: 'If a run is still going',
        catchUpLabel: 'If Interborough was off',
      });
      const policies = requiredInstance(
        container.querySelector('.cinder-schedule-builder__policies'),
        HTMLElement,
      );
      const panel = requiredInstance(
        container.querySelector('.cinder-schedule-builder__panel'),
        HTMLElement,
      );

      expect(
        panel.compareDocumentPosition(policies) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const overlap = requiredInstance(
        getByLabelText('If a run is still going'),
        HTMLSelectElement,
      );
      const catchUp = requiredInstance(
        getByLabelText('If Interborough was off'),
        HTMLSelectElement,
      );
      expect(overlap.selectedOptions[0]?.textContent?.trim()).toBe('Skip this one');
      expect(catchUp.selectedOptions[0]?.textContent?.trim()).toBe('Don’t catch up on missed runs');
      // Plain bordered selects, not the ghost variant.
      expect(overlap.getAttribute('data-cinder-variant')).not.toBe('ghost');
      expect(policies.contains(overlap) && policies.contains(catchUp)).toBe(true);
    });

    test('either select can stand alone', () => {
      const overlapOnly = render(ScheduleBuilder, { overlap: 'allow' });
      expect(overlapOnly.queryByLabelText('If the app was off')).toBeNull();
      expect(
        requiredInstance(overlapOnly.getByLabelText('If a run is still going'), HTMLSelectElement)
          .value,
      ).toBe('allow');
      cleanup();
      const catchUpOnly = render(ScheduleBuilder, { catchUp: true });
      expect(catchUpOnly.queryByLabelText('If a run is still going')).toBeNull();
      expect(
        requiredInstance(
          catchUpOnly.getByLabelText('If the app was off'),
          HTMLSelectElement,
        ).selectedOptions[0]?.textContent?.trim(),
      ).toBe('Catch up on missed runs');
    });

    test('reports a changed overlap and catch-up, and leaves the schedule value alone', async () => {
      const onOverlapChange = mock();
      const onCatchUpChange = mock();
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, {
        overlap: 'skip',
        catchUp: false,
        onOverlapChange,
        onCatchUpChange,
        onValueChange,
      });

      await fireEvent.change(getByLabelText('If a run is still going'), {
        target: { value: 'allow' },
      });
      await fireEvent.change(getByLabelText('If the app was off'), { target: { value: 'on' } });

      expect(onOverlapChange).toHaveBeenCalledWith('allow');
      expect(onCatchUpChange).toHaveBeenCalledWith(true);
      expect(onValueChange).not.toHaveBeenCalled();
    });

    test('takes its own choices and words', () => {
      const { getByLabelText } = render(ScheduleBuilder, {
        overlap: 'queue',
        overlapOptions: [
          { value: 'skip', label: 'Skip it' },
          { value: 'queue', label: 'Wait for it' },
        ],
        catchUp: true,
        catchUpOptionLabels: { on: 'Run what was missed', off: 'Forget what was missed' },
      });
      expect(
        Array.from(
          requiredInstance(getByLabelText('If a run is still going'), HTMLSelectElement).options,
          (option) => option.textContent?.trim(),
        ),
      ).toEqual(['Skip it', 'Wait for it']);
      expect(
        requiredInstance(
          getByLabelText('If the app was off'),
          HTMLSelectElement,
        ).selectedOptions[0]?.textContent?.trim(),
      ).toBe('Run what was missed');
    });
  });

  describe('compact variant', () => {
    const fires = [
      { id: 'a', label: 'Tue Nov 3, 9:00 AM CST' },
      { id: 'b', label: 'Wed Nov 4, 9:00 AM CST' },
    ];

    test('puts Repeats, At and Time zone in one row, with the zone named alone', () => {
      const { container, getByLabelText } = render(ScheduleBuilder, {
        variant: 'compact',
        value: { cron: '0 9 * * 1-5', timeZone: 'America/Chicago' },
      });
      const row = requiredInstance(
        container.querySelector('[data-cinder-fields="primary"]'),
        HTMLElement,
      );

      expect(row.contains(getByLabelText('Repeats'))).toBe(true);
      expect(row.contains(getByLabelText('At'))).toBe(true);
      expect(row.querySelector('button[role="combobox"]')?.textContent?.trim()).toBe(
        'Central time',
      );
    });

    test('draws no Runs sentence and no inset panel, and lists Next runs after the policy selects', () => {
      const { container } = render(ScheduleBuilder, {
        variant: 'compact',
        value: { cron: '0 9 * * 1-5', timeZone: 'America/Chicago' },
        overlap: 'skip',
        catchUp: false,
        computeNextFires: stubComputeNextFires(fires),
      });
      const policies = requiredInstance(
        container.querySelector('.cinder-schedule-builder__policies'),
        HTMLElement,
      );
      const preview = requiredInstance(
        container.querySelector('.cinder-schedule-builder__preview'),
        HTMLElement,
      );

      expect(container.querySelector('.cinder-schedule-builder__panel')).toBeNull();
      expect(container.querySelector('.cinder-schedule-builder__summary-text')).toBeNull();
      expect(preview.textContent).toContain('Next runs');
      expect(
        policies.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        Array.from(container.querySelectorAll('.cinder-schedule-builder__preview-item')).map(
          (item) => item.textContent,
        ),
      ).toEqual(['Tue Nov 3, 9:00 AM CST', 'Wed Nov 4, 9:00 AM CST']);
    });

    test('the open list still names the city', async () => {
      const { container } = render(ScheduleBuilder, {
        variant: 'compact',
        value: { cron: '0 9 * * 1-5', timeZone: 'America/Chicago' },
      });
      await fireEvent.click(
        requiredInstance(container.querySelector('button[role="combobox"]'), HTMLButtonElement),
      );
      await waitFor(() =>
        expect(document.body.querySelector('[role="option"]')?.textContent).toContain(
          'Central time · Chicago',
        ),
      );
    });

    test('an interval keeps its help line and shows no zone', () => {
      const { container, getByText } = render(ScheduleBuilder, {
        variant: 'compact',
        value: { every: { unit: 'hours', count: 2 }, timeZone: 'America/Chicago' },
      });
      expect(container.querySelector('button[role="combobox"]')).toBeNull();
      expect(
        getByText('An interval counts from when you create it, so no time zone applies.'),
      ).not.toBeNull();
    });

    test('an invalid cron says there is no preview, plainly', async () => {
      const { container } = render(ScheduleBuilder, {
        variant: 'compact',
        value: { cron: '0 9 * * 8', timeZone: 'UTC' },
        computeNextFires: stubComputeNextFires(fires),
      });
      expect(container.textContent).toContain('No preview until the cron expression is valid.');
      expect(container.querySelector('.cinder-schedule-builder__preview-list')).toBeNull();
    });
  });

  describe('controlled value resync', () => {
    test('a post-mount value change re-seeds the fields and read-back', async () => {
      const { container, getByLabelText, rerender } = render(ScheduleBuilder, {
        value: { every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' },
      });
      expect(readBack(container)).toBe('Every 15 minutes.');

      await rerender({ value: { cron: '0 9 * * 1', timeZone: 'UTC' } });

      expect(requiredInstance(getByLabelText('Repeats'), HTMLSelectElement).value).toBe(
        'custom-days',
      );
      expect(readBack(container)).toBe('Mondays at 9:00 AM UTC.');
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
      expect(readBack(container)).toBe('Every day at 9:00 AM UTC.');
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

    test('the Runs sentence is named by its Runs label', () => {
      const { container } = render(ScheduleBuilder, {});
      expect(container.querySelector('.cinder-schedule-builder__panel')?.textContent).toContain(
        'Runs',
      );
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
    const tail = 'Cron uses minute, hour, day of month, month and day of week.';

    test('shows five labelled fields in one row, each with its range beneath', () => {
      const { container, getByLabelText } = render(ScheduleBuilder, { value: CUSTOM_CRON });
      const names = ['Minute', 'Hour', 'Day of month', 'Month', 'Day of week'];
      const hints = ['0–59', '0–23', '1–31', '1–12', '0–6 (Sun–Sat)'];

      names.forEach((name, index) => {
        const field = requiredInstance(getByLabelText(name), HTMLInputElement);
        expect(field.getAttribute('data-cinder-variant')).toBe('code');
        const describedBy = field.getAttribute('aria-describedby') ?? '';
        expect(document.getElementById(describedBy.split(' ')[0] ?? '')?.textContent).toBe(
          hints[index],
        );
      });
      expect(
        container.querySelectorAll('.cinder-schedule-builder__cron-fields input'),
      ).toHaveLength(5);
      expect(requiredInstance(getByLabelText('Day of month'), HTMLInputElement).value).toBe('1-7');
      // No pattern selects and no disclosures: the fields are the expression.
      expect(container.querySelector('details')).toBeNull();
      expect(container.querySelector('[id$="-mode"]')).toBeNull();
    });

    test('a valid edit commits a joined expression', async () => {
      const onValueChange = mock();
      const { getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'cron');
      await fireEvent.input(getByLabelText('Minute'), { target: { value: '30' } });

      expect(onValueChange.mock.calls.at(-1)![0]).toEqual({ cron: '30 9 * * *', timeZone: 'UTC' });
    });

    test('an invalid field turns red and one message names it, with the glyph', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'UTC' },
        onValueChange,
      });

      await chooseRepeats(getByLabelText, 'cron');
      onValueChange.mockClear();
      const dayOfWeek = requiredInstance(getByLabelText('Day of week'), HTMLInputElement);
      await fireEvent.input(dayOfWeek, { target: { value: '8' } });

      expect(dayOfWeek.getAttribute('aria-invalid')).toBe('true');
      expect(getByLabelText('Minute').getAttribute('aria-invalid')).toBeNull();
      const error = requiredInstance(
        container.querySelector('.cinder-schedule-builder__cron-error'),
        HTMLElement,
      );
      expect(error.textContent?.trim()).toBe(`Day of week must be 0 to 6 (0 is Sunday). ${tail}`);
      expect(error.querySelector('svg')).not.toBeNull();
      expect(dayOfWeek.getAttribute('aria-describedby')).toContain(error.id);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(onValueChange).not.toHaveBeenCalled();
    });

    test('every field that needs fixing is marked and the first one is named', async () => {
      const { container, getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'UTC' },
      });
      await chooseRepeats(getByLabelText, 'cron');
      await fireEvent.input(getByLabelText('Hour'), { target: { value: '99' } });
      await fireEvent.input(getByLabelText('Month'), { target: { value: '13' } });

      expect(getByLabelText('Hour').getAttribute('aria-invalid')).toBe('true');
      expect(getByLabelText('Month').getAttribute('aria-invalid')).toBe('true');
      expect(
        container.querySelector('.cinder-schedule-builder__cron-error')?.textContent?.trim(),
      ).toBe(`Hour must be 0 to 23. ${tail}`);
    });

    test('the Runs panel then reads one muted line and lists no next runs', async () => {
      const computeNextFires = stubComputeNextFires();
      const { container, getByLabelText } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * *', timeZone: 'UTC' },
        computeNextFires,
      });
      await chooseRepeats(getByLabelText, 'cron');
      computeNextFires.mockClear();
      await fireEvent.input(getByLabelText('Day of week'), { target: { value: '8' } });

      const panel = requiredInstance(
        container.querySelector('.cinder-schedule-builder__panel'),
        HTMLElement,
      );
      expect(panel.textContent).toContain('No preview until the cron expression is valid.');
      expect(panel.textContent).not.toContain('Next runs');
      expect(panel.querySelector('.cinder-schedule-builder__summary-text')).toBeNull();
      expect(container.querySelector('.cinder-schedule-builder__preview-list')).toBeNull();
      expect(computeNextFires).not.toHaveBeenCalled();
      // The error sits at its field; there is no banner.
      expect(container.querySelector('.cinder-banner, [role="alert"]')).toBeNull();
    });

    test('says there is no preview even when no preview is supplied', () => {
      const { container } = render(ScheduleBuilder, {
        value: { cron: '0 9 * * 8', timeZone: 'UTC' },
      });
      expect(container.textContent).toContain('No preview until the cron expression is valid.');
    });

    test('correcting a field clears the error and resumes emitting', async () => {
      const onValueChange = mock();
      const { container, getByLabelText } = render(ScheduleBuilder, { onValueChange });

      await chooseRepeats(getByLabelText, 'cron');
      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });
      expect(onValueChange).toHaveBeenCalledTimes(1);

      await fireEvent.input(hourField, { target: { value: '10' } });

      expect(onValueChange).toHaveBeenCalledTimes(2);
      expect(onValueChange.mock.calls[1]![0]).toEqual({ cron: '0 10 * * *', timeZone: 'UTC' });
      expect(hourField.getAttribute('aria-invalid')).toBeNull();
      expect(
        container.querySelector('.cinder-schedule-builder__cron-error')?.textContent?.trim(),
      ).toBe('');
    });

    test('uses the form field error style instead of a style of its own', () => {
      const css = readFileSync(new URL('./schedule-builder.css', import.meta.url), 'utf8');
      expect(css).toContain("@import '../form-field/form-field.css'");
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

    test('does not call computeNextFires while a cron field is invalid', async () => {
      const computeNextFires = stubComputeNextFires();
      const { container, getByLabelText } = render(ScheduleBuilder, {
        computeNextFires,
      });

      await chooseRepeats(getByLabelText, 'cron');
      computeNextFires.mockClear();

      const hourField = requiredInstance(getByLabelText('Hour'), HTMLInputElement);
      await fireEvent.input(hourField, { target: { value: '99' } });

      expect(computeNextFires).not.toHaveBeenCalled();
      expect(container.textContent).toContain('No preview until the cron expression is valid.');
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

    test('aggregates the styles of the fields it composes before the component layer', async () => {
      const { readFileSync } = await import('node:fs');
      const css = readFileSync(new URL('./schedule-builder.css', import.meta.url), 'utf8');
      for (const imported of ['chip', 'combobox', 'form-field', 'input', 'select']) {
        const at = css.indexOf(`@import '../${imported}/${imported}.css'`);
        expect(at).toBeGreaterThan(css.indexOf('@layer cinder.tokens'));
        expect(at).toBeLessThan(css.indexOf('@layer cinder.components'));
      }
    });
  });
});
