/// <reference lib="dom" />
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import { detentHeight } from './drawer-detents.ts';
import { emptySnippet, installDrawerDialogStubs, textSnippet } from './drawer-test-helpers.ts';
import type { DrawerProps } from './drawer.types.ts';

setupHappyDom();
installDrawerDialogStubs();
const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Drawer } = await import('./drawer.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
});

function sheetProps(overrides: Partial<DrawerProps> = {}): DrawerProps {
  return {
    open: true,
    placement: 'bottom',
    title: 'Runs',
    detents: ['peek', 'medium', 'large'],
    detent: 'medium',
    children: emptySnippet,
    ...overrides,
  };
}

/** A bottom sheet with no detents, so its height is its content's. */
function plainSheetProps(overrides: Partial<DrawerProps> = {}): DrawerProps {
  return { open: true, placement: 'bottom', title: 'Runs', children: emptySnippet, ...overrides };
}

function panelOf(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-drawer__panel'), HTMLElement);
}

function grabberOf(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-drawer__drag-handle'), HTMLElement);
}

function detentOf(container: HTMLElement): string | null {
  return panelOf(container).getAttribute('data-cinder-detent');
}

describe('Drawer detents (COR-2322 AC1)', () => {
  test('a sheet without detents has no detent and a decorative grabber', () => {
    const { container } = render(Drawer, { props: plainSheetProps() });
    expect(detentOf(container)).toBeNull();
    expect(grabberOf(container).getAttribute('aria-hidden')).toBe('true');
    expect(grabberOf(container).hasAttribute('role')).toBe(false);
  });

  test('rests at the requested detent', () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'large' }) });
    expect(detentOf(container)).toBe('large');
  });

  test('rests at the smallest detent when the requested one is not listed', () => {
    const { container } = render(Drawer, {
      props: sheetProps({ detents: ['medium', 'large'], detent: 'peek' }),
    });
    expect(detentOf(container)).toBe('medium');
  });

  test('a side drawer ignores detents', () => {
    const { container } = render(Drawer, { props: sheetProps({ placement: 'right' }) });
    expect(detentOf(container)).toBeNull();
    expect(container.querySelector('.cinder-drawer__drag-handle')).toBeNull();
  });

  test('a single detent fixes the height and leaves the grabber decorative', () => {
    const { container } = render(Drawer, { props: sheetProps({ detents: ['medium'] }) });
    expect(detentOf(container)).toBe('medium');
    expect(grabberOf(container).getAttribute('aria-hidden')).toBe('true');
  });

  test('with two or more detents the grabber is a focusable window splitter', () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);
    expect(grabber.getAttribute('role')).toBe('separator');
    expect(grabber.getAttribute('aria-orientation')).toBe('horizontal');
    expect(grabber.getAttribute('aria-label')).toBe('Resize sheet');
    expect(grabber.getAttribute('tabindex')).toBe('0');
    expect(grabber.getAttribute('aria-valuemin')).toBe('0');
    expect(grabber.getAttribute('aria-valuemax')).toBe('2');
    expect(grabber.getAttribute('aria-valuenow')).toBe('1');
    expect(grabber.getAttribute('aria-valuetext')).toBe('Half height');
    expect(grabber.hasAttribute('aria-hidden')).toBe(false);
  });

  test('the grabber shows with detents even when dragHandleVisible is false', () => {
    const { container } = render(Drawer, { props: sheetProps({ dragHandleVisible: false }) });
    expect(grabberOf(container).getAttribute('role')).toBe('separator');
  });
});

describe('Drawer detent keyboard resizing', () => {
  test('ArrowUp and ArrowDown step between detents and stop at the ends', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.keyDown(grabber, { key: 'ArrowUp' });
    expect(detentOf(container)).toBe('large');
    expect(grabber.getAttribute('aria-valuenow')).toBe('2');
    expect(grabber.getAttribute('aria-valuetext')).toBe('Full height');

    await fireEvent.keyDown(grabber, { key: 'ArrowUp' });
    expect(detentOf(container)).toBe('large');

    await fireEvent.keyDown(grabber, { key: 'ArrowDown' });
    await fireEvent.keyDown(grabber, { key: 'ArrowDown' });
    expect(detentOf(container)).toBe('peek');

    await fireEvent.keyDown(grabber, { key: 'ArrowDown' });
    expect(detentOf(container)).toBe('peek');
  });

  test('Home and End jump to the smallest and largest detents', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.keyDown(grabber, { key: 'End' });
    expect(detentOf(container)).toBe('large');
    await fireEvent.keyDown(grabber, { key: 'Home' });
    expect(detentOf(container)).toBe('peek');
  });

  test('Enter and Space step up and wrap from the largest to the smallest', async () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'peek' }) });
    const grabber = grabberOf(container);

    await fireEvent.keyDown(grabber, { key: 'Enter' });
    expect(detentOf(container)).toBe('medium');
    await fireEvent.keyDown(grabber, { key: ' ' });
    expect(detentOf(container)).toBe('large');
    await fireEvent.keyDown(grabber, { key: 'Enter' });
    expect(detentOf(container)).toBe('peek');
  });

  test('a handled key is consumed and an unrelated key is left alone', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    grabber.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);

    const ignored = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    grabber.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
  });
});

describe('Drawer detent dragging', () => {
  const viewportHeight = () => window.innerHeight;

  test('follows the pointer while dragging and snaps to the nearest detent on release', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);
    const panel = panelOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 600 });
    await fireEvent.pointerMove(grabber, {
      pointerId: 1,
      clientY: 600 - viewportHeight() * 0.4,
    });
    expect(panel.hasAttribute('data-cinder-dragging')).toBe(true);
    expect(Number.parseFloat(panel.style.height)).toBeCloseTo(
      detentHeight('large', viewportHeight()),
      1,
    );

    await fireEvent.pointerUp(grabber, { pointerId: 1, clientY: 600 - viewportHeight() * 0.4 });
    expect(panel.hasAttribute('data-cinder-dragging')).toBe(false);
    expect(panel.style.height).toBe('');
    expect(detentOf(container)).toBe('large');
  });

  test('a drag down past the smallest detent holds at it and rests at peek', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 100 });
    await fireEvent.pointerMove(grabber, { pointerId: 1, clientY: 100 + viewportHeight() });
    expect(Number.parseFloat(panelOf(container).style.height)).toBeCloseTo(
      detentHeight('peek', viewportHeight()),
      1,
    );
    await fireEvent.pointerUp(grabber, { pointerId: 1, clientY: 100 + viewportHeight() });
    expect(detentOf(container)).toBe('peek');
  });

  test('a press and release without movement is a tap that steps to the next detent', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 300 });
    await fireEvent.pointerUp(grabber, { pointerId: 1, clientY: 300 });
    expect(detentOf(container)).toBe('large');
  });

  test('a cancelled drag leaves the detent where it was', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 600 });
    await fireEvent.pointerMove(grabber, { pointerId: 1, clientY: 100 });
    await fireEvent.pointerCancel(grabber, { pointerId: 1 });
    expect(detentOf(container)).toBe('medium');
    expect(panelOf(container).hasAttribute('data-cinder-dragging')).toBe(false);
  });

  test('a secondary mouse button does not start a drag', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 2, clientY: 600 });
    await fireEvent.pointerMove(grabber, { pointerId: 1, clientY: 100 });
    expect(panelOf(container).hasAttribute('data-cinder-dragging')).toBe(false);
  });

  test('a second pointer is ignored while a drag is in progress', async () => {
    const { container } = render(Drawer, { props: sheetProps() });
    const grabber = grabberOf(container);

    await fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 600 });
    await fireEvent.pointerDown(grabber, { pointerId: 2, button: 0, clientY: 100 });
    await fireEvent.pointerMove(grabber, { pointerId: 2, clientY: 50 });
    expect(panelOf(container).hasAttribute('data-cinder-dragging')).toBe(false);
  });
});

describe('Drawer peek detent (COR-2322 AC6)', () => {
  test('collapses to a bar with the title and a polite live count', () => {
    const { container } = render(Drawer, {
      props: sheetProps({ detent: 'peek', count: '12 results' }),
    });
    const peek = requiredInstance(container.querySelector('.cinder-drawer__peek'), HTMLElement);
    expect(panelOf(container).hasAttribute('data-cinder-peek')).toBe(true);
    expect(peek.tagName).toBe('BUTTON');
    expect(peek.querySelector('.cinder-drawer__peek-title')?.textContent).toBe('Runs');
    const live = requiredInstance(peek.querySelector('.cinder-drawer__peek-count'), HTMLElement);
    expect(live.textContent).toBe('12 results');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  test('the dialog keeps its name from the title while the header is hidden', () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'peek' }) });
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLElement);
    const title = requiredInstance(container.querySelector('.cinder-drawer__title'), HTMLElement);
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });

  test('draws no peek bar at the other detents', () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'medium' }) });
    expect(container.querySelector('.cinder-drawer__peek')).toBeNull();
    expect(panelOf(container).hasAttribute('data-cinder-peek')).toBe(false);
  });

  test('a tap on the bar opens the sheet and moves focus to the grabber', async () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'peek' }) });
    const peek = requiredInstance(container.querySelector('.cinder-drawer__peek'), HTMLElement);

    await fireEvent.click(peek);
    expect(detentOf(container)).toBe('medium');
    expect(container.querySelector('.cinder-drawer__peek')).toBeNull();
    await waitUntil(() => document.activeElement === grabberOf(container));
  });

  test('a drag on the bar opens the sheet to the nearest detent', async () => {
    const { container } = render(Drawer, { props: sheetProps({ detent: 'peek' }) });
    const peek = requiredInstance(container.querySelector('.cinder-drawer__peek'), HTMLElement);

    await fireEvent.pointerDown(peek, { pointerId: 1, button: 0, clientY: 700 });
    await fireEvent.pointerMove(peek, { pointerId: 1, clientY: 700 - window.innerHeight * 0.5 });
    await fireEvent.pointerUp(peek, { pointerId: 1, clientY: 700 - window.innerHeight * 0.5 });
    expect(detentOf(container)).toBe('medium');
  });

  test('a lone peek detent is a bar that cannot open', () => {
    const { container } = render(Drawer, { props: sheetProps({ detents: ['peek'] }) });
    const peek = requiredInstance(container.querySelector('.cinder-drawer__peek'), HTMLElement);
    expect(peek.tagName).toBe('DIV');
  });
});

describe('Drawer header bar (COR-2322 AC7)', () => {
  test('a bottom sheet with an action draws the three-column header bar', () => {
    const { container } = render(Drawer, {
      props: plainSheetProps({ closeLabel: 'Cancel', action: textSnippet('Apply') }),
    });
    const header = requiredInstance(container.querySelector('.cinder-drawer__header'), HTMLElement);
    expect(header.hasAttribute('data-cinder-bar')).toBe(true);
    expect(header.querySelector('.cinder-drawer__close')?.textContent?.trim()).toBe('Cancel');
    expect(header.querySelector('.cinder-drawer__title')?.textContent).toBe('Runs');
    expect(header.querySelector('.cinder-drawer__action')?.textContent).toBe('Apply');
  });

  test('keeps the DOM order title, close, action so focus runs Cancel then the action', () => {
    const { container } = render(Drawer, {
      props: plainSheetProps({ closeLabel: 'Cancel', action: textSnippet('Apply') }),
    });
    const header = requiredInstance(container.querySelector('.cinder-drawer__header'), HTMLElement);
    expect([...header.children].map((child) => child.className.split(' ')[0])).toEqual([
      'cinder-drawer__title',
      'cinder-drawer__close',
      'cinder-drawer__action',
    ]);
  });

  test('the title stays a heading for assistive technology', () => {
    const { container } = render(Drawer, {
      props: plainSheetProps({ action: textSnippet('Apply') }),
    });
    expect(container.querySelector('h2.cinder-drawer__title')?.textContent).toBe('Runs');
  });

  test('a bottom sheet without an action keeps the plain header, even with a worded close control', () => {
    const { container } = render(Drawer, { props: plainSheetProps({ closeLabel: 'Cancel' }) });
    expect(container.querySelector('.cinder-drawer__header')?.hasAttribute('data-cinder-bar')).toBe(
      false,
    );
  });

  test('a side drawer and a custom header never draw the bar', () => {
    const side = render(Drawer, {
      props: plainSheetProps({
        placement: 'right',
        closeLabel: 'Cancel',
        action: textSnippet('Apply'),
      }),
    });
    expect(
      side.container.querySelector('.cinder-drawer__header')?.hasAttribute('data-cinder-bar'),
    ).toBe(false);
    expect(side.container.querySelector('.cinder-drawer__action')).toBeNull();
    side.unmount();

    const custom = render(Drawer, {
      props: sheetProps({
        closeLabel: 'Cancel',
        action: textSnippet('Apply'),
        header: textSnippet('Custom'),
      }),
    });
    expect(
      custom.container.querySelector('.cinder-drawer__header')?.hasAttribute('data-cinder-bar'),
    ).toBe(false);
    expect(custom.container.querySelector('.cinder-drawer__action')).toBeNull();
  });
});
