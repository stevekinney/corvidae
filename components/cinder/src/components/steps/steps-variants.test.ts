/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { declarationsFor } from '../../test/css.ts';
import type { StepItem } from './steps.types.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: Steps } = await import('./steps.svelte');

const stepsCss = await Bun.file(new URL('./steps.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** A stand-in action that records the state the step passed in. */
const stateAction = createRawSnippet<[string]>((state) => ({
  render: () => `<button type="button" data-testid="action">${state()}</button>`,
}));

const checklistSteps = [
  {
    id: 'provider',
    label: 'Connect a provider',
    description: 'Agents need a model provider before they can answer.',
    action: stateAction,
  },
  {
    id: 'agent',
    label: 'Create an agent, or start from Assistant',
    description: 'Assistant works now; other agents need a provider.',
    action: stateAction,
  },
  {
    id: 'hello',
    label: 'Say hello',
    description: 'Send a first message to see a chat run end to end.',
    action: stateAction,
  },
];

function itemsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.cinder-steps__item')];
}

describe('Steps checklist variant', () => {
  test('is a section named by its heading, with a "N of M done" counter', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
    });
    const root = container.querySelector('.cinder-steps');
    expect(root?.tagName).toBe('SECTION');
    expect(root?.getAttribute('data-cinder-variant')).toBe('checklist');
    expect(root?.hasAttribute('data-cinder-orientation')).toBe(false);
    const heading = container.querySelector('.cinder-steps__heading');
    expect(heading?.tagName).toBe('H3');
    expect(heading?.textContent?.trim()).toBe('Get started');
    expect(root?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(root?.hasAttribute('aria-label')).toBe(false);
    expect(container.querySelector('.cinder-steps__progress')?.textContent).toBe('0 of 3 done');
  });

  test('without a heading the section is named by label and draws no header', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      label: 'First run',
    });
    const root = container.querySelector('.cinder-steps');
    expect(root?.getAttribute('aria-label')).toBe('First run');
    expect(container.querySelector('.cinder-steps__header')).toBeNull();
  });

  test('headingLevel sets the heading tag and clamps a bad value', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
      headingLevel: 2,
    });
    expect(container.querySelector('.cinder-steps__heading')?.tagName).toBe('H2');
    cleanup();
    const clamped = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
      headingLevel: 9 as never,
    });
    expect(clamped.container.querySelector('.cinder-steps__heading')?.tagName).toBe('H6');
  });

  test('the first step that is not done is current, and later ones are upcoming', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
    });
    expect(itemsOf(container).map((item) => item.getAttribute('data-cinder-state'))).toEqual([
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Connect a provider',
    );
  });

  test('steps complete in any order: done steps are complete wherever they sit', () => {
    const steps = checklistSteps.map((step) => ({ ...step, done: step.id === 'agent' }));
    const { container } = render(Steps, { steps, variant: 'checklist', heading: 'Get started' });
    expect(itemsOf(container).map((item) => item.getAttribute('data-cinder-state'))).toEqual([
      'current',
      'complete',
      'upcoming',
    ]);
    expect(container.querySelector('.cinder-steps__progress')?.textContent).toBe('1 of 3 done');
  });

  test('two done steps leave the last one current and read "2 of 3 done"', () => {
    const steps = checklistSteps.map((step) => ({ ...step, done: step.id !== 'hello' }));
    const { container } = render(Steps, { steps, variant: 'checklist', heading: 'Get started' });
    const items = itemsOf(container);
    expect(items.map((item) => item.getAttribute('data-cinder-state'))).toEqual([
      'complete',
      'complete',
      'current',
    ]);
    expect(container.querySelector('.cinder-steps__progress')?.textContent).toBe('2 of 3 done');
    // A done step announces itself and shows a check rather than its number.
    expect(items[0]?.querySelector('svg.cinder-steps__check')).not.toBeNull();
    expect(items[0]?.textContent).toContain('Completed');
    expect(items[2]?.querySelector('.cinder-steps__index')?.textContent).toBe('3');
  });

  test('every step done leaves no current step', () => {
    const steps = checklistSteps.map((step) => ({ ...step, done: true }));
    const { container } = render(Steps, { steps, variant: 'checklist', heading: 'Get started' });
    expect(container.querySelector('[aria-current]')).toBeNull();
    expect(container.querySelector('.cinder-steps__progress')?.textContent).toBe('3 of 3 done');
  });

  test('progressLabel replaces the counter text', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
      progressLabel: (done: number, total: number) => `${done}/${total}`,
    });
    expect(container.querySelector('.cinder-steps__progress')?.textContent).toBe('0/3');
  });

  test('renders each step action beside its body and passes the step state in', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      variant: 'checklist',
      heading: 'Get started',
    });
    const actions = [...container.querySelectorAll('.cinder-steps__action')];
    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.textContent?.trim())).toEqual([
      'current',
      'upcoming',
      'upcoming',
    ]);
    // The action is a sibling of the body, never inside the marker or the body.
    for (const action of actions) {
      expect(action.closest('.cinder-steps__body')).toBeNull();
      expect(action.closest('.cinder-steps__marker')).toBeNull();
    }
  });

  test('draws no connector and omits the action of a step that has none', () => {
    const steps: StepItem[] = checklistSteps.map(({ action, ...step }, index) =>
      index === 0 ? { ...step, done: true } : { ...step, action },
    );
    const { container } = render(Steps, { steps, variant: 'checklist', heading: 'Get started' });
    expect(container.querySelector('.cinder-steps__connector')).toBeNull();
    expect(container.querySelectorAll('.cinder-steps__action')).toHaveLength(2);
  });

  test('stepper ignores per-step actions and done flags', () => {
    const { container } = render(Steps, {
      steps: checklistSteps.map((step) => ({ ...step, done: true })),
      currentStep: 1,
    });
    expect(container.querySelector('.cinder-steps__action')).toBeNull();
    expect(itemsOf(container).map((item) => item.getAttribute('data-cinder-state'))).toEqual([
      'complete',
      'current',
      'upcoming',
    ]);
  });

  test('an unknown variant behaves as the stepper', () => {
    const { container } = render(Steps, {
      steps: checklistSteps,
      currentStep: 0,
      variant: 'bogus' as never,
    });
    expect(container.querySelector('nav.cinder-steps')).not.toBeNull();
  });

  test('the stylesheet makes it a bordered card with a 24px marker row and a stacking action', () => {
    const card = declarationsFor(stepsCss, ".cinder-steps[data-cinder-variant='checklist']");
    expect(card.get('border')).toBe('1px solid var(--cinder-border-faint)');
    expect(card.get('border-radius')).toBe('var(--cinder-radius-lg)');
    const base = declarationsFor(stepsCss, '.cinder-steps');
    expect(base.get('--_marker-size')).toBe('1.5rem');
    const done = declarationsFor(
      stepsCss,
      ".cinder-steps[data-cinder-variant='checklist'] [data-cinder-state='complete'] .cinder-steps__marker",
    );
    expect(done.get('background')).toBe('var(--cinder-status-success-background)');
    const current = declarationsFor(
      stepsCss,
      ".cinder-steps[data-cinder-variant='checklist'] [data-cinder-state='current'] .cinder-steps__marker",
    );
    expect(current.get('background')).toBe('var(--cinder-accent-solid)');
    expect(stepsCss).toContain('@container cinder-steps (max-width: 28rem)');
  });
});

describe('Steps status variant', () => {
  const restartSteps = [
    { id: 'saved', label: 'Saved your choice', done: true },
    { id: 'stopped', label: 'Stopped the server', done: true },
    { id: 'starting', label: 'Starting Interborough' },
    { id: 'plugins', label: 'Checking plugins' },
  ];

  test('is a status region named by label, with no navigation landmark', () => {
    const { container } = render(Steps, {
      steps: restartSteps,
      variant: 'status',
      label: 'Restart progress',
    });
    const root = container.querySelector('.cinder-steps');
    expect(root?.tagName).toBe('DIV');
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-label')).toBe('Restart progress');
    expect(container.querySelector('nav')).toBeNull();
  });

  test('shows a check, a spinner and a hollow circle, and announces each state in words', () => {
    const { container } = render(Steps, { steps: restartSteps, variant: 'status' });
    const items = itemsOf(container);
    expect(items.map((item) => item.getAttribute('data-cinder-state'))).toEqual([
      'complete',
      'complete',
      'current',
      'upcoming',
    ]);
    expect(items[0]?.querySelector('svg.cinder-steps__check')).not.toBeNull();
    expect(items[2]?.querySelector('.cinder-steps__spinner')).not.toBeNull();
    expect(items[3]?.querySelector('.cinder-steps__pending')).not.toBeNull();
    const words = items.map((item) => item.querySelector('.cinder-steps__sr-only')?.textContent);
    expect(words).toEqual(['Completed', 'Completed', 'In progress', 'Pending']);
    // The marks are decorative; the words carry the state.
    for (const item of items) {
      expect(item.querySelector('.cinder-steps__marker')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.querySelector('.cinder-steps__index')).toBeNull();
    expect(container.querySelector('.cinder-steps__connector')).toBeNull();
  });

  test('currentLabel and pendingLabel replace the announced words', () => {
    const { container } = render(Steps, {
      steps: restartSteps,
      variant: 'status',
      currentLabel: 'Working',
      pendingLabel: 'Waiting',
    });
    const words = itemsOf(container).map(
      (item) => item.querySelector('.cinder-steps__sr-only')?.textContent,
    );
    expect(words).toEqual(['Completed', 'Completed', 'Working', 'Waiting']);
  });

  test('the list reads in order and marks the running step as current', () => {
    const { container } = render(Steps, { steps: restartSteps, variant: 'status' });
    expect(
      itemsOf(container).map((item) =>
        item.querySelector('.cinder-steps__label')?.textContent?.trim(),
      ),
    ).toEqual([
      'Saved your choice',
      'Stopped the server',
      'Starting Interborough',
      'Checking plugins',
    ]);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Starting Interborough',
    );
  });

  test('the spinner animation is driven by the shared spin duration, so reduced motion stops it', () => {
    const spinner = declarationsFor(stepsCss, '.cinder-steps__spinner');
    expect(spinner.get('animation')).toBe(
      'cinder-steps-spin var(--cinder-duration-spin) linear infinite',
    );
  });
});
