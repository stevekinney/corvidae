/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

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
const { tick } = await import('svelte');
const { default: ListDetailFixture } = await import('./list-detail.fixture.svelte');
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
    await measure(container, 899);

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
    await measure(container, 600);

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
    expect(remembered).toBeGreaterThan(320);
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
    expect(remembered).toBeGreaterThan(320);

    await measure(container, 800);
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
});
