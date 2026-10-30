/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Popover } = await import('./popover.svelte');
const { default: Combobox } = await import('../combobox/combobox.svelte');
const { default: MultiSelect } = await import('../multi-select/multi-select.svelte');
const { default: Dropdown } = await import('../dropdown/dropdown.svelte');
const { default: DropdownCompoundFixture } =
  await import('../../test/fixtures/dropdown-compound-fixture.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

beforeEach(() => {
  document.body.replaceChildren();
  resetEscapeStack();
});

afterEach(() => {
  cleanup();
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
});

const triggerSnippet = createRawSnippet(() => ({
  render: () => `<button type="button">Open</button>`,
  setup: () => {},
}));

const contentSnippet = createRawSnippet(() => ({
  render: () => `<span>Quick settings</span>`,
  setup: () => {},
}));

function openPopover(props: Record<string, unknown> = {}) {
  return render(Popover, {
    props: {
      open: true,
      label: 'Quick settings',
      trigger: triggerSnippet,
      children: contentSnippet,
      ...props,
    },
  });
}

describe('Popover sheetBelow', () => {
  test('below 640px a focus-taking popover opens in the bottom Drawer', async () => {
    setTestViewportWidth(375);
    openPopover({ id: 'settings' });

    let drawer: HTMLDialogElement | null = null;
    await waitFor(() => {
      drawer = document.body.querySelector<HTMLDialogElement>('dialog.cinder-drawer');
      if (!drawer?.querySelector('[data-cinder-placement="bottom"]')) {
        throw new Error('bottom drawer not rendered');
      }
    });
    const content = document.getElementById('settings');
    expect(content?.closest('dialog')).toBe(drawer);
    expect(content?.getAttribute('data-cinder-sheet')).toBe('drawer');
    // The Drawer is the dialog; the content carries no second dialog role.
    expect(content?.hasAttribute('role')).toBe(false);
    expect(drawer!.querySelector('.cinder-drawer__title')?.textContent).toBe('Quick settings');
    expect(document.body.querySelector('.cinder-popover')).toBeNull();
  });

  test('closing the bottom Drawer closes the popover', async () => {
    setTestViewportWidth(375);
    let open = true;
    render(Popover, {
      props: {
        get open() {
          return open;
        },
        set open(value: boolean) {
          open = value;
        },
        label: 'Quick settings',
        trigger: triggerSnippet,
        children: contentSnippet,
      },
    });
    let close: HTMLButtonElement | null = null;
    await waitFor(() => {
      close = document.body.querySelector<HTMLButtonElement>('.cinder-drawer__close');
      if (!close) throw new Error('close button not rendered');
    });
    await fireEvent.click(close!);
    await waitFor(() => {
      if (open) throw new Error('popover still open');
    });
  });

  test('below 640px a popover that keeps focus on its trigger docks its own panel', async () => {
    setTestViewportWidth(375);
    openPopover({ focusManagement: 'preserve', role: 'group' });

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-popover')) throw new Error('panel not rendered');
    });
    const panel = document.body.querySelector<HTMLElement>('.cinder-popover')!;
    expect(panel.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(panel.getAttribute('style')).toBeNull();
    expect(document.body.querySelector('dialog.cinder-drawer')).toBeNull();
  });

  test('at tablet width the popover stays anchored', async () => {
    setTestViewportWidth(768);
    openPopover();

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-popover')) throw new Error('panel not rendered');
    });
    expect(document.body.querySelector('.cinder-popover')?.hasAttribute('data-cinder-sheet')).toBe(
      false,
    );
    expect(document.body.querySelector('dialog.cinder-drawer')).toBeNull();
  });

  test('sheetBelow={false} keeps the popover anchored on a phone', async () => {
    setTestViewportWidth(375);
    openPopover({ sheetBelow: false });

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-popover')) throw new Error('panel not rendered');
    });
    expect(document.body.querySelector('dialog.cinder-drawer')).toBeNull();
  });

  test("the bottom Drawer focuses the caller's initialFocus choice", async () => {
    setTestViewportWidth(375);
    const twoButtons = createRawSnippet(() => ({
      render: () =>
        `<div><button type="button">First day</button><button type="button" data-selected>Selected day</button></div>`,
      setup: () => {},
    }));
    openPopover({
      children: twoButtons,
      initialFocus: (panel: HTMLElement) => panel.querySelector<HTMLElement>('[data-selected]'),
    });

    await waitFor(() => {
      if (document.activeElement?.textContent !== 'Selected day') {
        throw new Error(`focus is on ${document.activeElement?.className ?? 'nothing'}`);
      }
    });
  });

  test('onExitComplete waits for the bottom Drawer to finish closing', async () => {
    setTestViewportWidth(375);
    const panelPresentAtExit: boolean[] = [];
    openPopover({
      onExitComplete: () => {
        panelPresentAtExit.push(document.body.querySelector('.cinder-drawer__panel') !== null);
      },
    });
    let close: HTMLButtonElement | null = null;
    await waitFor(() => {
      close = document.body.querySelector<HTMLButtonElement>('.cinder-drawer__close');
      if (!close) throw new Error('close button not rendered');
    });
    expect(panelPresentAtExit).toEqual([]);

    await fireEvent.click(close!);
    await waitFor(() => {
      if (panelPresentAtExit.length === 0) throw new Error('exit not reported');
    });
    expect(panelPresentAtExit).toEqual([false]);
  });

  test('rejects a sheetBelow that is not a CSS length', () => {
    expect(() => openPopover({ sheetBelow: 'small' })).toThrow(
      'Popover sheetBelow must be a CSS length such as "640px", or false.',
    );
  });
});

describe('sheetBelow in the pickers', () => {
  const fruits = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
  ];

  test('Combobox docks its listbox and keeps focus in the input', async () => {
    setTestViewportWidth(375);
    render(Combobox, { id: 'fruit', options: fruits, label: 'Fruit' });
    const input = document.getElementById('fruit') as HTMLInputElement;
    input.focus();
    await fireEvent.focus(input);

    await waitFor(() => {
      if (!document.body.querySelector('[role="listbox"]')) throw new Error('listbox closed');
    });
    const panel = document.body.querySelector<HTMLElement>('.cinder-combobox__panel');
    expect(panel?.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(document.activeElement).toBe(input);
  });

  test('MultiSelect docks its options panel', async () => {
    setTestViewportWidth(375);
    render(MultiSelect, {
      id: 'fruits',
      label: 'Fruits',
      items: [
        { id: 'apple', label: 'Apple' },
        { id: 'banana', label: 'Banana' },
      ],
    });
    await fireEvent.click(document.getElementById('fruits')!);

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-multi-select__panel')) {
        throw new Error('panel closed');
      }
    });
    const panel = document.body.querySelector<HTMLElement>('.cinder-multi-select__panel')!;
    expect(panel.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(panel.getAttribute('style')).toBeNull();
  });

  test('MultiSelect stays anchored at tablet width', async () => {
    setTestViewportWidth(768);
    render(MultiSelect, {
      id: 'fruits',
      label: 'Fruits',
      items: [{ id: 'apple', label: 'Apple' }],
    });
    await fireEvent.click(document.getElementById('fruits')!);

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-multi-select__panel')) {
        throw new Error('panel closed');
      }
    });
    expect(
      document.body.querySelector('.cinder-multi-select__panel')?.hasAttribute('data-cinder-sheet'),
    ).toBe(false);
  });

  test('a compound Dropdown docks its menu and drops the anchored placement', async () => {
    setTestViewportWidth(375);
    render(DropdownCompoundFixture);
    await fireEvent.click(document.body.querySelector<HTMLButtonElement>('.trigger')!);

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-dropdown-menu')) throw new Error('menu closed');
    });
    const menu = document.body.querySelector<HTMLElement>('.cinder-dropdown-menu')!;
    expect(menu.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(menu.hasAttribute('data-cinder-placement')).toBe(false);
    expect(
      document.body.querySelector('.cinder-dropdown')?.hasAttribute('data-cinder-placement'),
    ).toBe(false);
  });

  test('a snippet Dropdown docks its menu', async () => {
    setTestViewportWidth(375);
    render(Dropdown, {
      props: { open: true, trigger: triggerSnippet, children: contentSnippet },
    });

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-dropdown__menu')) throw new Error('menu closed');
    });
    expect(
      document.body.querySelector('.cinder-dropdown__menu')?.getAttribute('data-cinder-sheet'),
    ).toBe('docked');
  });

  test('a Dropdown at desktop width keeps its placement', async () => {
    render(DropdownCompoundFixture);
    await fireEvent.click(document.body.querySelector<HTMLButtonElement>('.trigger')!);

    await waitFor(() => {
      if (!document.body.querySelector('.cinder-dropdown-menu')) throw new Error('menu closed');
    });
    const menu = document.body.querySelector<HTMLElement>('.cinder-dropdown-menu')!;
    expect(menu.hasAttribute('data-cinder-sheet')).toBe(false);
    expect(menu.getAttribute('data-cinder-placement')).not.toBeNull();
  });
});
