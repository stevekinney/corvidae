/// <reference lib="dom" />
/**
 * COR-2181: `overflow="select"` draws the options as a Select when the segments are wider than the
 * room the control has. happy-dom has no layout, so each test says how wide the segments are and how
 * much room there is, and runs the observer by hand.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { requiredValue, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/segmented-control-fixture.svelte');
const { installOverflowFadeTestEnvironment, OverflowFadeResizeObserver } =
  await import('../../test/overflow-fade-test-helpers.ts');

const options = [
  { value: 'webhook', label: 'Send a webhook' },
  { value: 'workflow', label: 'Start a workflow' },
  { value: 'notify', label: 'Notify me' },
  { value: 'plugin', label: 'Run an action from a plugin' },
];

let restoreEnvironment: (() => void) | undefined;
beforeEach(() => {
  document.body.replaceChildren();
  restoreEnvironment = installOverflowFadeTestEnvironment();
});
afterEach(() => {
  cleanup();
  restoreEnvironment?.();
});

/** Says how wide the strip is by itself, and how much room the control's parent gives it. */
function layout(container: HTMLElement, natural: number, available: number) {
  const strip = requiredValue(container.querySelector<HTMLElement>('.cinder-segmented-control'));
  Object.defineProperty(strip, 'offsetWidth', { configurable: true, get: () => natural });
  Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => available });
  return {
    strip,
    measure: () => {
      for (const observer of OverflowFadeResizeObserver.instances) observer.trigger();
    },
  };
}

function mount(overflow: 'scroll' | 'select' | undefined, value = 'webhook') {
  const view = render(Fixture, {
    props: {
      id: 'then',
      label: 'Then',
      value,
      options,
      ...(overflow === undefined ? {} : { rest: { overflow } }),
    },
  });
  return view;
}

describe('SegmentedControl overflow="select"', () => {
  test('stays the strip while the segments fit', async () => {
    const view = mount('select');
    layout(view.container, 320, 400).measure();

    expect(screen.getByRole('radiogroup', { name: 'Then' })).not.toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(view.container.querySelector('select, [role="combobox"]')).toBeNull();
  });

  test('is a Select with the same name and every option when the segments do not fit', async () => {
    const view = mount('select', 'notify');
    layout(view.container, 560, 320).measure();

    const select = await waitFor(() => {
      const found = view.container.querySelector<HTMLSelectElement>('select');
      if (found === null) throw new Error('no select');
      return found;
    });
    expect(screen.getByLabelText('Then')).toBe(select);
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual(
      options.map((option) => option.label),
    );
    expect(select.value).toBe('notify');
    // The strip stays in the document so its width is still known, and it is out of sight and reach.
    const strip = requiredValue(view.container.querySelector('.cinder-segmented-control'));
    expect(strip.hasAttribute('data-cinder-measuring')).toBe(true);
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.hasAttribute('inert')).toBe(true);
  });

  test('choosing in the Select changes the value as clicking a segment does', async () => {
    const view = mount('select');
    layout(view.container, 560, 320).measure();
    const select = await waitFor(() => {
      const found = view.container.querySelector<HTMLSelectElement>('select');
      if (found === null) throw new Error('no select');
      return found;
    });

    select.value = 'plugin';
    await fireEvent.change(select);

    await waitFor(() => expect(select.value).toBe('plugin'));
    const strip = requiredValue(view.container.querySelector('.cinder-segmented-control'));
    expect(
      requiredValue(
        [...strip.querySelectorAll('[role="radio"]')].find((radio) =>
          radio.textContent?.includes('Run an action'),
        ),
      ).getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('returns to the strip when the room is there again, and never flips on its own', async () => {
    const view = mount('select');
    const { measure } = layout(view.container, 560, 320);
    measure();
    await waitFor(() => expect(view.container.querySelector('select')).not.toBeNull());

    // Measuring again with the same room changes nothing: the strip's width does not depend on what shows.
    measure();
    measure();
    expect(view.container.querySelector('select')).not.toBeNull();

    Object.defineProperty(view.container, 'clientWidth', { configurable: true, get: () => 800 });
    measure();
    await waitFor(() => expect(view.container.querySelectorAll('select')).toHaveLength(0));
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  test('is never a Select without the prop, whatever the width', async () => {
    const view = mount(undefined);
    layout(view.container, 560, 320).measure();

    expect(view.container.querySelector('select')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(
      view.container
        .querySelector('.cinder-segmented-control')
        ?.hasAttribute('data-cinder-measuring'),
    ).toBe(false);
  });

  test('is never a Select for a tab list, a navigation or a multiple selection', async () => {
    const tablist = render(Fixture, {
      props: {
        id: 'tabs',
        label: 'Tabs',
        value: 'webhook',
        options,
        variant: 'tablist',
        rest: { overflow: 'select' },
      },
    });
    layout(tablist.container, 560, 320).measure();
    expect(tablist.container.querySelector('select')).toBeNull();
  });
});
