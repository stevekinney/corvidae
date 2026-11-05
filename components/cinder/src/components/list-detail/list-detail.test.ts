/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, jest, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  callback: ResizeObserverCallback;
  target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {}

  unobserve(): void {}

  static flush(): void {
    for (const instance of ResizeObserverStub.instances) {
      if (!instance.target) continue;
      instance.callback(
        [
          {
            target: instance.target,
            contentRect: instance.target.getBoundingClientRect(),
          } as ResizeObserverEntry,
        ],
        instance,
      );
    }
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverStub,
});
afterAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: originalResizeObserver,
  });
});

const { cleanup, fireEvent, render } = await import('@testing-library/svelte/pure');
const { flushSync, tick } = await import('svelte');
const { default: ListDetailFixture } = await import('./list-detail.fixture.svelte');
const { default: ListDetailTableFixture } = await import('./list-detail-table.fixture.svelte');
const { stripCinderComponentsLayer } = await import('../../test/css.ts');
const { LIST_DETAIL_SHORTCUTS } = await import('./list-detail.constants.ts');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  ResizeObserverStub.instances = [];
});

function rectOf(width: number): DOMRect {
  return {
    width,
    height: 600,
    left: 0,
    top: 0,
    right: width,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  };
}

/** Gives the root, the panel group and the divider a width, then lets the observers see it. */
async function measure(container: HTMLElement, rootWidth: number): Promise<void> {
  const root = container.querySelector<HTMLElement>('.cinder-list-detail')!;
  root.getBoundingClientRect = () => rectOf(rootWidth);
  const panels = container.querySelector<HTMLElement>('.cinder-resizable-panels');
  if (panels) panels.getBoundingClientRect = () => rectOf(rootWidth);
  const handle = container.querySelector<HTMLElement>('.cinder-resizable-panels__handle');
  if (handle) handle.getBoundingClientRect = () => rectOf(12);
  ResizeObserverStub.flush();
  await tick();
}

function memoryLocation(initial: string | null = null) {
  let current = initial;
  return {
    read: mock((_parameter: string) => current),
    write: mock((_parameter: string, next: string | null) => {
      current = next;
    }),
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: mock((storageKey: string) => values.get(storageKey) ?? null),
    setItem: mock((storageKey: string, value: string) => void values.set(storageKey, value)),
    values,
  };
}

const rowOf = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`li[data-cinder-list-detail-key="${key}"]`)!;
const primaryOf = (container: HTMLElement, key: string) =>
  rowOf(container, key).querySelector<HTMLElement>('.cinder-selectable-row__primary')!;
const detailText = (container: HTMLElement) =>
  container.querySelector('.cinder-list-detail__detail-body')?.textContent?.trim();

describe('ListDetail', () => {
  test('lists the rows, names the regions, and starts with the empty detail', () => {
    const { container, getByRole, getByText } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });

    expect(getByRole('region', { name: 'Chats' })).toBeTruthy();
    expect(getByRole('region', { name: 'Details' })).toBeTruthy();
    expect(container.querySelectorAll('li[data-cinder-list-detail-key]')).toHaveLength(3);
    expect(getByText('Nothing selected')).toBeTruthy();
    expect(getByRole('heading', { name: 'Chats' })).toBeTruthy();
  });

  test('flushDetail marks the root so the detail pane drops its inner padding', () => {
    const flush = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), flushDetail: true },
    });
    expect(
      flush.container
        .querySelector('.cinder-list-detail')
        ?.hasAttribute('data-cinder-flush-detail'),
    ).toBe(true);
    flush.unmount();

    const padded = render(ListDetailFixture, { props: { selectionLocation: memoryLocation() } });
    expect(
      padded.container
        .querySelector('.cinder-list-detail')
        ?.hasAttribute('data-cinder-flush-detail'),
    ).toBe(false);
  });

  test('renders the list empty state and a custom empty detail title', () => {
    const { getByText } = render(ListDetailFixture, {
      props: { items: [], selectionLocation: memoryLocation(), emptyTitle: 'Pick a chat' },
    });

    expect(getByText('No chats yet')).toBeTruthy();
    expect(getByText('Pick a chat')).toBeTruthy();
  });

  test('the list region declares the keys LIST_DETAIL_SHORTCUTS describes', () => {
    const { getByRole } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });

    expect(LIST_DETAIL_SHORTCUTS.map((shortcut) => shortcut.keys.join('+'))).toEqual([
      'J',
      'K',
      'Enter',
    ]);
    expect(getByRole('region', { name: 'Chats' }).getAttribute('aria-keyshortcuts')).toBe(
      'J K Enter',
    );
  });

  test('J and K move the cursor and focus, Enter opens, and the URL follows', async () => {
    const location = memoryLocation();
    const onSelectedKeyChange = mock();
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: location, onSelectedKeyChange },
    });

    await fireEvent.keyDown(primaryOf(container, 'alpha'), { key: 'j' });
    await tick();
    expect(document.activeElement).toBe(primaryOf(container, 'alpha'));
    expect(rowOf(container, 'alpha').hasAttribute('data-cinder-active')).toBe(true);

    await fireEvent.keyDown(document.activeElement!, { key: 'J' });
    await tick();
    expect(document.activeElement).toBe(primaryOf(container, 'beta'));

    await fireEvent.keyDown(document.activeElement!, { key: 'j' });
    await fireEvent.keyDown(document.activeElement!, { key: 'j' });
    await tick();
    expect(document.activeElement).toBe(primaryOf(container, 'gamma'));

    await fireEvent.keyDown(document.activeElement!, { key: 'k' });
    await tick();
    expect(document.activeElement).toBe(primaryOf(container, 'beta'));

    expect(detailText(container)).toContain('Nothing selected');
    await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await tick();

    expect(detailText(container)).toBe('Beta chat detail');
    expect(onSelectedKeyChange).toHaveBeenCalledWith('beta');
    expect(location.write).toHaveBeenCalledWith('selected', 'beta');
    expect(primaryOf(container, 'beta').getAttribute('aria-current')).toBe('true');
  });

  test('ignores J, K and modified keys while a person is typing or holding a modifier', async () => {
    const { container, getByLabelText } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });
    const search = getByLabelText('Search chats');

    await fireEvent.keyDown(search, { key: 'j' });
    await fireEvent.keyDown(primaryOf(container, 'alpha'), { key: 'j', ctrlKey: true });
    await tick();

    expect(container.querySelector('[data-cinder-active]')).toBeNull();
  });

  test('J and K are not taken from a menu inside a row', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    rowOf(container, 'alpha').append(menu);

    await fireEvent.keyDown(item, { key: 'j' });

    expect(container.querySelector('[data-cinder-active]')).toBeNull();
  });

  test('Enter on a row action does not open the row', async () => {
    const location = memoryLocation();
    const { container, getByRole } = render(ListDetailFixture, {
      props: { selectionLocation: location },
    });

    await fireEvent.keyDown(getByRole('button', { name: 'More actions for Alpha chat' }), {
      key: 'Enter',
    });
    await tick();

    expect(detailText(container)).toContain('Nothing selected');
    expect(location.write).not.toHaveBeenCalled();
  });

  test('clicking a row opens it', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });

    await fireEvent.click(primaryOf(container, 'gamma'));
    await tick();

    expect(detailText(container)).toBe('Gamma chat detail');
  });

  test('restores the selection from the URL on mount, without writing it back', async () => {
    const location = memoryLocation('beta');
    const onSelectedKeyChange = mock();
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: location, onSelectedKeyChange },
    });
    await tick();

    expect(location.read).toHaveBeenCalledWith('selected');
    expect(detailText(container)).toBe('Beta chat detail');
    expect(onSelectedKeyChange).toHaveBeenCalledWith('beta');
    expect(location.write).not.toHaveBeenCalled();
    expect(primaryOf(container, 'beta').getAttribute('aria-current')).toBe('true');
  });

  test('an explicit selectedKey wins over the URL, and is written to it', async () => {
    const location = memoryLocation('beta');
    const onSelectedKeyChange = mock();
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: location, selectedKey: 'gamma', onSelectedKeyChange },
    });
    await tick();

    expect(detailText(container)).toBe('Gamma chat detail');
    expect(location.write).toHaveBeenCalledWith('selected', 'gamma');
    expect(location.read('selected')).toBe('gamma');
    expect(onSelectedKeyChange).not.toHaveBeenCalled();
  });

  test('an explicit selectedKey is written to a URL that holds no selection', async () => {
    const location = memoryLocation();
    render(ListDetailFixture, {
      props: { selectionLocation: location, selectedKey: 'alpha' },
    });
    await tick();

    expect(location.write).toHaveBeenCalledTimes(1);
    expect(location.write).toHaveBeenCalledWith('selected', 'alpha');
  });

  test('a URL key that names no row shows the empty detail', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation('deleted') },
    });
    await tick();

    expect(detailText(container)).toContain('Nothing selected');
  });

  test('uses the configured search parameter, and none when it is null', async () => {
    const location = memoryLocation('beta');
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: location, selectionParameter: 'chat' },
    });
    await tick();
    expect(location.read).toHaveBeenCalledWith('chat');
    await fireEvent.click(primaryOf(container, 'gamma'));
    await tick();
    expect(location.write).toHaveBeenCalledWith('chat', 'gamma');
    cleanup();

    const unsynced = memoryLocation('beta');
    const second = render(ListDetailFixture, {
      props: { selectionLocation: unsynced, selectionParameter: null },
    });
    await fireEvent.click(primaryOf(second.container, 'gamma'));
    await tick();
    expect(unsynced.read).not.toHaveBeenCalled();
    expect(unsynced.write).not.toHaveBeenCalled();
    expect(detailText(second.container)).toBe('Gamma chat detail');
  });

  test('reads and writes the address bar by default, keeping other parameters', async () => {
    window.history.replaceState(null, '', '/chats?filter=open&selected=gamma');
    const { container } = render(ListDetailFixture, {});
    await tick();
    expect(detailText(container)).toBe('Gamma chat detail');

    await fireEvent.click(primaryOf(container, 'alpha'));
    await tick();
    expect(new URL(window.location.href).searchParams.get('selected')).toBe('alpha');
    expect(new URL(window.location.href).searchParams.get('filter')).toBe('open');
    window.history.replaceState(null, '', '/');
  });

  test('shows both panes when wide, and treats an unmeasured width as wide', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });

    expect(container.querySelector('.cinder-list-detail')?.getAttribute('data-cinder-layout')).toBe(
      'split',
    );
    await measure(container, 1000);
    expect(container.querySelector('.cinder-list-detail')?.getAttribute('data-cinder-layout')).toBe(
      'split',
    );
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    expect(container.querySelector('.cinder-list-detail__back')).toBeNull();
  });

  test('below pushBelow it shows the list, then the detail with Back', async () => {
    const location = memoryLocation();
    const { container, getByRole, queryByRole } = render(ListDetailFixture, {
      props: { selectionLocation: location },
    });
    await measure(container, 599);

    const root = container.querySelector('.cinder-list-detail')!;
    expect(root.getAttribute('data-cinder-layout')).toBe('stacked');
    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(queryByRole('region', { name: 'Details' })).toBeNull();
    expect(getByRole('region', { name: 'Chats' })).toBeTruthy();

    await fireEvent.click(primaryOf(container, 'beta'));
    await tick();
    await tick();

    expect(queryByRole('region', { name: 'Chats' })).toBeNull();
    expect(detailText(container)).toBe('Beta chat detail');
    const back = getByRole('button', { name: 'Back' });
    expect(document.activeElement).toBe(back);
    expect(location.write).toHaveBeenLastCalledWith('selected', 'beta');

    await fireEvent.click(back);
    await tick();
    await tick();

    expect(getByRole('region', { name: 'Chats' })).toBeTruthy();
    expect(queryByRole('region', { name: 'Details' })).toBeNull();
    expect(location.write).toHaveBeenLastCalledWith('selected', null);
    expect(document.activeElement).toBe(primaryOf(container, 'beta'));
  });

  test('a selection restored from the URL opens straight to the detail when narrow', async () => {
    const { container, getByRole } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation('alpha') },
    });
    await measure(container, 400);

    expect(detailText(container)).toBe('Alpha chat detail');
    expect(getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  test('pushBelow and backLabel are configurable', async () => {
    const { container, getByRole } = render(ListDetailFixture, {
      props: {
        selectionLocation: memoryLocation('alpha'),
        pushBelow: 1200,
        backLabel: 'All chats',
      },
    });
    await measure(container, 1000);

    expect(container.querySelector('.cinder-list-detail')?.getAttribute('data-cinder-layout')).toBe(
      'stacked',
    );
    expect(getByRole('button', { name: 'All chats' })).toBeTruthy();
  });

  test('starts the divider at the remembered width', async () => {
    const storage = memoryStorage({ chats: '410' });
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(container, 1000);

    const listPane = container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain('--_cinder-resizable-panel-size: 410px');
    expect(storage.getItem).toHaveBeenCalledWith('chats');
  });

  test('starts at defaultListWidth when nothing is remembered', async () => {
    const { container } = render(ListDetailFixture, {
      props: {
        selectionLocation: memoryLocation(),
        storage: memoryStorage(),
        storageKey: 'chats',
        defaultListWidth: 280,
      },
    });
    await measure(container, 1000);

    const listPane = container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain('--_cinder-resizable-panel-size: 280px');
  });

  test('remembers the width the divider is moved to, across a remount', async () => {
    const storage = memoryStorage();
    const first = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(first.container, 1000);
    const writesBeforeDrag = storage.setItem.mock.calls.length;

    const handle = first.container.querySelector<HTMLElement>('[role="separator"]')!;
    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await tick();

    expect(storage.setItem.mock.calls.length).toBeGreaterThan(writesBeforeDrag);
    const remembered = Number(storage.values.get('chats'));
    expect(remembered).toBeGreaterThan(280);
    cleanup();
    ResizeObserverStub.instances = [];

    const second = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(second.container, 1000);
    const listPane = second.container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain(
      `--_cinder-resizable-panel-size: ${remembered}px`,
    );
  });

  test('restores a remembered width wider than half the container', async () => {
    const storage = memoryStorage({ chats: '550' });
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(container, 1000);

    const listPane = container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain('--_cinder-resizable-panel-size: 550px');
  });

  test('keeps the dragged width after narrowing below pushBelow and widening again', async () => {
    const storage = memoryStorage();
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(container, 1000);
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await tick();
    const remembered = Number(storage.values.get('chats'));
    expect(remembered).toBeGreaterThan(280);

    await measure(container, 500);
    expect(container.querySelector('.cinder-list-detail')!.getAttribute('data-cinder-layout')).toBe(
      'stacked',
    );
    await measure(container, 1000);
    await measure(container, 1000);

    const listPane = container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain(
      `--_cinder-resizable-panel-size: ${remembered}px`,
    );
  });

  test('does not remember the width of a container resize, or without a storage key', async () => {
    const storage = memoryStorage();
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage, storageKey: 'chats' },
    });
    await measure(container, 1000);
    await measure(container, 1100);
    expect(storage.setItem).not.toHaveBeenCalled();
    cleanup();
    ResizeObserverStub.instances = [];

    const unkeyed = memoryStorage();
    const second = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), storage: unkeyed },
    });
    await measure(second.container, 1000);
    const handle = second.container.querySelector<HTMLElement>('[role="separator"]')!;
    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await tick();
    expect(unkeyed.setItem).not.toHaveBeenCalled();
  });

  test('forwards the class and attributes to the root', () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), class: 'custom', 'data-testid': 'chats' },
    });
    const root = container.querySelector('.cinder-list-detail')!;

    expect(root.classList.contains('custom')).toBe(true);
    expect(root.getAttribute('data-testid')).toBe('chats');
  });

  test('shows both panes at tablet width and one pane at phone width', async () => {
    const tablet = render(ListDetailFixture, { props: { selectionLocation: memoryLocation() } });
    await measure(tablet.container, 768);
    expect(
      tablet.container.querySelector('.cinder-list-detail')?.getAttribute('data-cinder-layout'),
    ).toBe('split');
    cleanup();
    ResizeObserverStub.instances = [];

    const phone = render(ListDetailFixture, { props: { selectionLocation: memoryLocation() } });
    await measure(phone.container, 375);
    expect(
      phone.container.querySelector('.cinder-list-detail')?.getAttribute('data-cinder-layout'),
    ).toBe('stacked');
  });

  test('starts the list pane at 280 pixels', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });
    await measure(container, 1000);
    const listPane = container.querySelector<HTMLElement>('.cinder-resizable-panels__pane')!;
    expect(listPane.getAttribute('style')).toContain('--_cinder-resizable-panel-size: 280px');
  });

  test('the detail pane keeps its own padding, which a variable can remove', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./list-detail.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-list-detail__detail-body \{[^}]*padding: var\(--cinder-list-detail-detail-padding, var\(--cinder-space-4\)\);/,
    );
  });

  test('draws a full-height 1px rule between the panes and shows the grip on hover or focus', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./list-detail.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-resizable-panels__handle::before \{[^}]*inset-block: 0;[^}]*inline-size: 0;[^}]*border-inline-start: 1px solid var\(--cinder-border-muted\);/,
    );
    expect(css).toMatch(
      /\.cinder-resizable-panels__handle\s+\.cinder-resizable-panels__handle-line \{\s*opacity: 0;/,
    );
    expect(css).toMatch(
      /:is\(:hover, :focus-visible\)\s+\.cinder-resizable-panels__handle-line \{\s*opacity: 1;/,
    );
  });

  test('a stacked layout flows with the page instead of scrolling inside itself', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./list-detail.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-list-detail\[data-cinder-layout='stacked'\] \{\s*block-size: auto;/,
    );
  });

  test('a flush detail shown alone fills the height it is given, and the list does not', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation(), flushDetail: true },
    });
    await measure(container, 599);
    const root = () => container.querySelector('.cinder-list-detail')!;
    expect(root().getAttribute('data-cinder-showing')).toBe('list');

    await fireEvent.click(primaryOf(container, 'beta'));
    await tick();
    await tick();
    expect(root().getAttribute('data-cinder-showing')).toBe('detail');

    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./list-detail.css', import.meta.url)).text(),
    );
    const fill = css.slice(css.indexOf("[data-cinder-showing='detail']"));
    expect(fill).toMatch(/\{\s*block-size: 100%;/);
    expect(css).not.toMatch(
      /\.cinder-list-detail\[data-cinder-layout='stacked'\]\[data-cinder-flush-detail\]\s*\{/,
    );
  });

  test('is not marked as showing a pane in the split layout', async () => {
    const { container } = render(ListDetailFixture, {
      props: { selectionLocation: memoryLocation() },
    });
    await measure(container, 1000);
    expect(
      container.querySelector('.cinder-list-detail')?.hasAttribute('data-cinder-showing'),
    ).toBe(false);
  });

  test('groups the rows under header bands', async () => {
    const { container } = render(ListDetailFixture, {
      props: {
        selectionLocation: memoryLocation(),
        groupBy: (chat: { id: string }) =>
          chat.id === 'gamma'
            ? { key: 'later', label: 'Later' }
            : { key: 'first', label: 'First', detail: 'two chats' },
      },
    });
    await measure(container, 1000);

    const labels = Array.from(container.querySelectorAll('.cinder-data-list-group__label')).map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(['First', 'Later']);
    expect(container.querySelectorAll('li[data-cinder-list-detail-key]')).toHaveLength(3);
  });

  describe('loading', () => {
    test('shows nothing for 300 ms, then five placeholder rows and a detail block, announced', () => {
      jest.useFakeTimers();
      try {
        const { container } = render(ListDetailFixture, {
          props: {
            selectionLocation: memoryLocation(),
            loading: true,
            loadingLabel: 'Loading memories',
          },
        });
        expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
        expect(container.querySelector('li[data-cinder-list-detail-key]')).toBeNull();

        jest.advanceTimersByTime(300);
        flushSync();

        expect(
          container.querySelectorAll('.cinder-list-detail__list .cinder-skeleton-row'),
        ).toHaveLength(5);
        expect(
          container.querySelector(
            '.cinder-list-detail__loading-detail .cinder-skeleton-card, .cinder-list-detail__loading-detail .cinder-skeleton-group',
          ),
        ).not.toBeNull();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading memories');
        expect(
          container.querySelector('.cinder-list-detail__rows')?.getAttribute('aria-busy'),
        ).toBe('true');
        // The header stays live while the rows load.
        expect(container.querySelector('input[aria-label="Search chats"]')).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    test('shows the rows again when loading ends', async () => {
      const { container, rerender } = render(ListDetailFixture, {
        props: { selectionLocation: memoryLocation(), loading: true },
      });
      await rerender({ selectionLocation: memoryLocation(), loading: false });
      await tick();
      expect(container.querySelectorAll('li[data-cinder-list-detail-key]')).toHaveLength(3);
    });
  });

  describe('a table in the list slot', () => {
    function rowOf(container: HTMLElement, id: string): HTMLElement {
      return container.querySelector<HTMLElement>(`tr[data-cinder-row-id="${id}"]`)!;
    }

    test('opens a row on click and shows its detail, with the row marked open', async () => {
      const { container } = render(ListDetailTableFixture, {
        props: { selectionLocation: memoryLocation() },
      });
      await measure(container, 1000);
      expect(container.querySelector('.cinder-list-detail__rows table')).not.toBeNull();

      await fireEvent.click(rowOf(container, 'beta').querySelector('td')!);
      await tick();

      expect(detailText(container)).toBe('app:beta value');
      expect(rowOf(container, 'beta').getAttribute('aria-current')).toBe('true');
      expect(rowOf(container, 'alpha').hasAttribute('aria-current')).toBe(false);
    });

    test('J and K move the cursor between table rows, and Enter opens the row', async () => {
      const { container } = render(ListDetailTableFixture, {
        props: { selectionLocation: memoryLocation() },
      });
      await measure(container, 1000);

      rowOf(container, 'alpha').focus();
      // With no cursor yet, the first press lands on the first row.
      await fireEvent.keyDown(rowOf(container, 'alpha'), { key: 'j' });
      await tick();
      await tick();
      expect(document.activeElement).toBe(rowOf(container, 'alpha'));
      await fireEvent.keyDown(rowOf(container, 'alpha'), { key: 'j' });
      await tick();
      await tick();
      expect(document.activeElement).toBe(rowOf(container, 'beta'));

      await fireEvent.keyDown(rowOf(container, 'beta'), { key: 'Enter' });
      await tick();
      expect(detailText(container)).toBe('app:beta value');
    });

    test('below pushBelow the table is the one pane, and a row pushes the detail with Back', async () => {
      const { container, getByRole } = render(ListDetailTableFixture, {
        props: { selectionLocation: memoryLocation() },
      });
      await measure(container, 400);
      expect(container.querySelector('.cinder-list-detail__rows table')).not.toBeNull();

      await fireEvent.click(rowOf(container, 'gamma').querySelector('td')!);
      await tick();
      await tick();

      expect(detailText(container)).toBe('chat:gamma value');
      expect(getByRole('button', { name: 'Back' })).toBeTruthy();
    });
  });
});
