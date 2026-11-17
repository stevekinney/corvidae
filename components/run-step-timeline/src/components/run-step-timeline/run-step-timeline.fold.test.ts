/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import type { RunStep } from './run-step-timeline.types.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: RunStepTimeline } = await import('./run-step-timeline.svelte');

afterEach(() => cleanup());

const entry = (index: number, overrides: Partial<RunStep> = {}): RunStep => ({
  id: `entry-${index}`,
  label: `Entry ${index}`,
  status: 'succeeded',
  time: `+${index} s`,
  ...overrides,
});
const entries = (count: number): RunStep[] => Array.from({ length: count }, (_, i) => entry(i));
const labels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.cinder-run-step-timeline__label')].map((label) =>
    (label.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

describe('RunStepTimeline narrative fold', () => {
  test('nine entries keep the first three and last three around one "3 more calls" row', () => {
    const { container } = render(RunStepTimeline, {
      steps: entries(9),
      variant: 'narrative',
      fold: { label: (hidden) => `${hidden} more calls` },
    });

    expect(container.querySelectorAll('li')).toHaveLength(7);
    expect(container.querySelectorAll('[data-cinder-fold]')).toHaveLength(1);
    expect(labels(container)).toContain('3 more calls');
    const action = container.querySelector('.cinder-run-step-timeline__fold-action');
    expect(action?.textContent?.trim()).toBe('Show all 9');
    expect(labels(container)[0]).toContain('Entry 0');
    expect(labels(container).at(-1)).toContain('Entry 8');
  });

  test('Show all opens the middle in place', async () => {
    const { container } = render(RunStepTimeline, {
      steps: entries(9),
      variant: 'narrative',
      fold: {},
    });
    await fireEvent.click(
      container.querySelector<HTMLElement>('.cinder-run-step-timeline__fold-action') as HTMLElement,
    );
    expect(container.querySelectorAll('li')).toHaveLength(9);
    expect(container.querySelector('[data-cinder-fold]')).toBeNull();
  });

  test('seven entries fold nothing because one hidden row saves nothing, and eight fold two', () => {
    const seven = render(RunStepTimeline, { steps: entries(7), variant: 'narrative', fold: {} });
    expect(seven.container.querySelectorAll('li')).toHaveLength(7);
    cleanup();
    const eight = render(RunStepTimeline, { steps: entries(8), variant: 'narrative', fold: {} });
    expect(eight.container.querySelectorAll('li')).toHaveLength(7);
    expect(labels(eight.container)).toContain('2 more steps');
  });

  test('a failed or waiting entry is never folded and splits the fold in two', () => {
    const steps = entries(14);
    steps[6] = entry(6, { status: 'failed', label: 'Entry 6 failed' });
    steps[9] = entry(9, { status: 'waiting_approval', label: 'Entry 9 waits' });
    const { container } = render(RunStepTimeline, { steps, variant: 'narrative', fold: {} });
    const shown = labels(container);
    expect(shown.some((label) => label.includes('Entry 6 failed'))).toBe(true);
    expect(shown.some((label) => label.includes('Entry 9 waits'))).toBe(true);
    // Entries 3-5 and 7-8 fold; the lone entry 10 between a waiting entry and the tail stays.
    expect(shown.filter((label) => label.endsWith('more steps'))).toEqual([
      '3 more steps',
      '2 more steps',
    ]);
    expect(shown.some((label) => label.includes('Entry 10'))).toBe(true);
    expect(container.querySelectorAll('[data-cinder-fold]')).toHaveLength(2);
  });

  test('the detailed variant ignores fold', () => {
    const { container } = render(RunStepTimeline, { steps: entries(12), fold: {} });
    expect(container.querySelectorAll('li')).toHaveLength(12);
  });
});

describe('RunStepTimeline note label', () => {
  test('a labelled note reads "Your note, " before its first line', () => {
    const { container } = render(RunStepTimeline, {
      variant: 'narrative',
      steps: [
        {
          id: 'denied',
          label: 'Denied',
          status: 'recorded',
          time: '+58 s',
          description: 'Denied by you at 9:21 AM',
          note: { label: 'Your note', lines: ['The customer already got a replacement.'] },
        },
      ],
    });
    const note = container.querySelector('.cinder-run-step-timeline__note');
    expect(note?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Your note, The customer already got a replacement.',
    );
    expect(note?.querySelector('.cinder-run-step-timeline__note-label')).not.toBeNull();
  });

  test('a failed call stays visible with a danger note and a red marker', () => {
    const { container } = render(RunStepTimeline, {
      variant: 'narrative',
      steps: [
        {
          id: 'failed-call',
          label: 'Looked up order 4470',
          status: 'failed',
          time: '+3 s',
          description: 'Used Lookup order `lookup-order`',
          note: {
            tone: 'danger',
            title: 'This call failed',
            lines: ["Lookup order didn't answer (HTTP 503) for order 4470."],
          },
        },
      ],
    });
    expect(container.querySelector('[data-cinder-status="failed"]')).not.toBeNull();
    expect(
      container.querySelector('.cinder-run-step-timeline__note[data-cinder-tone="danger"]'),
    ).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('lookup-order');
  });
});
