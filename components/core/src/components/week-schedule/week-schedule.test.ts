/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: WeekSchedule } = await import('./week-schedule.svelte');

describe('WeekSchedule', () => {
  test('renders one row per day with its day, range and description', () => {
    const { container } = render(WeekSchedule, {
      days: [
        { day: 'Mon', start: '2:00 pm', end: '8:00 pm', description: 'Half-price wells' },
        { day: 'Tue', start: '4:00 pm', end: '7:00 pm' },
      ],
    });
    const rows = [...container.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.cinder-week-schedule__day')?.textContent).toBe('Mon');
    expect(rows[0]?.querySelector('.cinder-week-schedule__times')?.textContent).toBe(
      '2:00 pm – 8:00 pm',
    );
    expect(rows[0]?.querySelector('.cinder-week-schedule__description')?.textContent).toContain(
      'Half-price wells',
    );
  });

  test('marks only today as the current date', () => {
    const { container } = render(WeekSchedule, {
      days: [
        { day: 'Mon', start: '2:00 pm', end: '8:00 pm' },
        { day: 'Tue', start: '2:00 pm', end: '8:00 pm', today: true },
      ],
    });
    const current = container.querySelectorAll('[aria-current="date"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Tue');
  });

  test('a live window shows an On now pill, and liveLabel replaces the text', () => {
    const { container } = render(WeekSchedule, {
      liveLabel: 'Open',
      days: [{ day: 'Mon', start: '2:00 pm', end: '8:00 pm', live: true }],
    });
    expect(container.querySelector('.cinder-week-schedule__live')?.textContent).toBe('Open');
  });

  test('a window that crosses midnight says next day inside the range', () => {
    const { container } = render(WeekSchedule, {
      days: [{ day: 'Fri', start: '10:00 pm', end: '2:00 am', endsNextDay: true }],
    });
    expect(container.querySelector('.cinder-week-schedule__times')?.textContent).toBe(
      '10:00 pm – 2:00 am next day',
    );
  });

  test('merges a custom class and names the list', () => {
    const { container } = render(WeekSchedule, { days: [], class: 'extra', label: 'Hours' });
    const list = container.querySelector('ol');
    expect(list?.classList.contains('cinder-week-schedule')).toBe(true);
    expect(list?.classList.contains('extra')).toBe(true);
    expect(list?.getAttribute('aria-label')).toBe('Hours');
  });

  test('stylesheet keeps the range unbroken and the day column at 56px', () => {
    const css = readFileSync(new URL('./week-schedule.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-week-schedule__times \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/grid-template-columns: 3\.5rem/);
  });
});
