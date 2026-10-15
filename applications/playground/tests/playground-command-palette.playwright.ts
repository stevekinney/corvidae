import { expect, test, type Page } from '@playwright/test';

const TRIGGER_NAME = 'Search components';

/**
 * Counts every `showModal()` call and the net number of listeners registered on
 * `window` and `document`, per event type, before any page script runs. The
 * palette's `<dialog>` opens through `showModal()`, so the call count is how
 * many times a press actually opened it.
 */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { showModalCalls: 0, listeners: {} as Record<string, number> };
    (window as unknown as { __paletteProbe: typeof state }).__paletteProbe = state;

    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      state.showModalCalls += 1;
      return showModal.call(this);
    };

    const tracked = new Map<EventTarget, Set<unknown>>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const keyFor = (target: EventTarget, type: string) =>
      `${target === window ? 'window' : 'document'}:${type}`;
    const capture = (options: unknown) =>
      typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean })?.capture);

    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if ((this === window || this === document) && listener !== null) {
        const registrations = tracked.get(this) ?? new Set();
        const identity = `${type}|${String(capture(options))}`;
        const key = [identity, listener] as const;
        const exists = [...registrations].some(
          (entry) => (entry as typeof key)[0] === identity && (entry as typeof key)[1] === listener,
        );
        if (!exists) {
          registrations.add(key);
          tracked.set(this, registrations);
          const name = keyFor(this, type);
          state.listeners[name] = (state.listeners[name] ?? 0) + 1;
        }
      }
      return add.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if ((this === window || this === document) && listener !== null) {
        const registrations = tracked.get(this);
        const identity = `${type}|${String(capture(options))}`;
        for (const entry of registrations ?? []) {
          const [entryIdentity, entryListener] = entry as readonly [string, unknown];
          if (entryIdentity === identity && entryListener === listener) {
            registrations?.delete(entry);
            const name = keyFor(this, type);
            state.listeners[name] = (state.listeners[name] ?? 0) - 1;
            break;
          }
        }
      }
      return remove.call(this, type, listener, options);
    };
  });
}

type Probe = { showModalCalls: number; listeners: Record<string, number> };

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() =>
    JSON.parse(JSON.stringify((window as unknown as { __paletteProbe: Probe }).__paletteProbe)),
  );
}

async function showModalCalls(page: Page): Promise<number> {
  const { showModalCalls: calls } = await probe(page);
  return calls;
}

async function openDocumentation(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('#app[data-playground-controls-hydrated]').waitFor({ state: 'attached' });
}

function trigger(page: Page) {
  return page.getByRole('button', { name: TRIGGER_NAME, exact: true });
}

function palette(page: Page) {
  return page.getByRole('dialog', { name: TRIGGER_NAME });
}

function searchInput(page: Page) {
  return palette(page).getByRole('combobox');
}

async function optionLabels(page: Page): Promise<string[]> {
  return palette(page)
    .getByRole('option')
    .allTextContents()
    .then((labels) => labels.map((label) => label.trim()));
}

async function sidebarLabels(page: Page): Promise<string[]> {
  return page
    .locator('nav.dx-nav .dx-nav__link')
    .allTextContents()
    .then((labels) => labels.map((label) => label.trim()));
}

const consoleProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const problems: string[] = [];
  consoleProblems.set(page, problems);
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await instrument(page);
});

// Any warning or error — a hydration mismatch, a failed showModal on a detached
// dialog, a chunk that failed to load — fails the test that produced it.
test.afterEach(({ page }) => {
  expect(consoleProblems.get(page) ?? []).toEqual([]);
});

test.describe('1440px viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the trigger sits below the brand and above the sidebar filter', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');

    const navigation = page.getByRole('navigation', { name: 'Components' });
    const brand = await navigation.getByRole('link', { name: 'CINDER' }).boundingBox();
    const button = await navigation.getByRole('button', { name: TRIGGER_NAME }).boundingBox();
    const filter = await navigation
      .getByRole('searchbox', { name: 'Filter components' })
      .boundingBox();
    if (brand === null || button === null || filter === null) {
      throw new Error('The brand, trigger, or filter is not rendered.');
    }
    expect(button.y).toBeGreaterThanOrEqual(brand.y + brand.height);
    expect(filter.y).toBeGreaterThanOrEqual(button.y + button.height);
    await expect(trigger(page)).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  });

  test('the palette code loads on first hover, once, and preloads no component pages', async ({
    page,
  }) => {
    await openDocumentation(page, '/page/action-row');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));

    // Nothing is fetched for the palette until the reader reaches for it.
    await page.waitForLoadState('networkidle');
    const idleRequests = requests.length;
    expect(await page.locator('dialog').count()).toBe(0);

    await trigger(page).hover();
    await page.waitForLoadState('networkidle');
    const afterHover = requests.slice(idleRequests);
    expect(afterHover.some((path) => path.endsWith('.js'))).toBe(true);

    await trigger(page).click();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    const afterFirstOpen = requests.length;

    await trigger(page).click();
    await expect(palette(page)).toBeVisible();
    await searchInput(page).fill('button');
    await page.waitForLoadState('networkidle');
    // Cached: reopening and searching fetch nothing, least of all destination pages.
    expect(requests.slice(afterFirstOpen)).toEqual([]);
    expect(requests.filter((path) => path.startsWith('/page/'))).toEqual([]);
  });

  test('results use the sidebar inventory and rank exact, prefix, then substring', async ({
    page,
  }) => {
    await openDocumentation(page, '/page/action-row');
    await trigger(page).click();
    await expect(palette(page)).toBeVisible();

    // An empty query lists the whole sidebar inventory, in label order.
    const inventory = await sidebarLabels(page);
    const listed = await optionLabels(page);
    expect(listed.toSorted()).toEqual(inventory.toSorted());
    expect(listed).toEqual(listed.toSorted((left, right) => left.localeCompare(right, 'en')));

    await searchInput(page).fill('BUTTON');
    const ranked = await optionLabels(page);
    expect(ranked[0]).toBe('Button');
    const prefix = ranked.filter(
      (label) => label.toLowerCase().startsWith('button') && label !== 'Button',
    );
    const substring = ranked.filter((label) => !label.toLowerCase().startsWith('button'));
    expect(ranked).toEqual(['Button', ...prefix, ...substring]);
    expect(prefix.length).toBeGreaterThan(0);
    expect(substring.length).toBeGreaterThan(0);
    expect(prefix).toEqual(prefix.toSorted((left, right) => left.localeCompare(right, 'en')));
    expect(substring).toEqual(substring.toSorted((left, right) => left.localeCompare(right, 'en')));

    await searchInput(page).fill('no such component');
    await expect(palette(page).getByRole('option')).toHaveCount(0);
    await expect(palette(page).getByRole('status')).toHaveText('No matching components.');
  });

  test('arrow keys move the selection and Enter navigates in place', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');
    await page.evaluate(() => {
      (window as unknown as { __beforeNavigation: boolean }).__beforeNavigation = true;
    });
    await trigger(page).click();
    await searchInput(page).fill('alert');

    const options = palette(page).getByRole('option');
    await expect(options.first()).toHaveText('Alert');
    // The first result starts selected, so Enter alone would take the best match.
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    const destinationText = await options.nth(1).textContent();
    const destination = destinationText?.trim();

    await Promise.all([page.waitForURL(/\/page\/alert-/), page.keyboard.press('Enter')]);
    await page.locator('[data-component-page] .dx-hero h1').waitFor();
    // The palette routes through the progressive navigation (CIN-589), so the window survives.
    expect(
      await page.evaluate(
        () => (window as unknown as { __beforeNavigation?: boolean }).__beforeNavigation,
      ),
    ).toBe(true);
    expect(destination).toBeDefined();
    await expect(
      page.getByRole('navigation', { name: 'Components' }).locator('[aria-current="page"]'),
    ).toHaveText(destination!);
  });

  test('the palette is a styled overlay centered over the page', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');
    await trigger(page).click();
    await expect(searchInput(page)).toBeFocused();

    const panel = await palette(page).boundingBox();
    if (panel === null) throw new Error('The palette is not rendered.');
    // Centered in the 1440px viewport rather than stacked inside the sidebar.
    expect(Math.abs(panel.x + panel.width / 2 - 720)).toBeLessThanOrEqual(2);
    expect(panel.y).toBeGreaterThan(0);
    expect(panel.width).toBeLessThanOrEqual(640);
    expect(
      await page.evaluate(() => {
        const element = document.querySelector('.cinder-command-palette__panel');
        return element === null ? null : getComputedStyle(element).display;
      }),
    ).toBe('flex');
  });

  test('Escape closes the palette and returns focus to the trigger', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');
    await trigger(page).click();
    await expect(searchInput(page)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test('Cmd/Ctrl+K opens the palette exactly once per press', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(searchInput(page)).toBeFocused();
    expect(await showModalCalls(page)).toBe(1);

    // A second press while it is open opens nothing new.
    await page.keyboard.press('ControlOrMeta+k');
    expect(await showModalCalls(page)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeVisible();
    expect(await showModalCalls(page)).toBe(2);
  });

  test('the shortcut is ignored while an editable control has focus', async ({ page }) => {
    await openDocumentation(page, '/page/input');

    const exampleInput = page.locator('[data-component-page] main input').first();
    await exampleInput.focus();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('searchbox', { name: 'Filter components' }).focus();
    await page.keyboard.press('ControlOrMeta+k');

    await page.waitForLoadState('networkidle');
    expect(await showModalCalls(page)).toBe(0);
    await expect(palette(page)).toHaveCount(0);
  });

  test('the shortcut is ignored while a demo dialog is open', async ({ page }) => {
    await openDocumentation(page, '/page/modal');

    // Examples mount when they scroll into view; the chromeless modal's first
    // focus lands on its Close button, so no editable control has focus here.
    await page.locator('#example-card-chromeless').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Open image viewer' }).click();
    const demo = page.getByRole('dialog', { name: 'Image viewer' });
    await expect(demo).toBeVisible();
    // Focus sits on a non-editable control, so only the open dialog blocks the shortcut.
    expect(
      await page.evaluate(() => {
        const active = document.activeElement;
        return (
          active !== null &&
          (active.closest('input, textarea, select') !== null ||
            (active instanceof HTMLElement && active.isContentEditable))
        );
      }),
    ).toBe(false);
    expect(await showModalCalls(page)).toBe(1);

    await page.keyboard.press('ControlOrMeta+k');
    await page.waitForLoadState('networkidle');
    expect(await showModalCalls(page)).toBe(1);
    await expect(palette(page)).toHaveCount(0);
  });

  test('five open and close cycles leave no listeners or dialogs behind', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');

    const cycle = async (opening: 'shortcut' | 'click', closing: 'escape' | 'backdrop') => {
      if (opening === 'shortcut') await page.keyboard.press('ControlOrMeta+k');
      else await trigger(page).click();
      await expect(palette(page)).toBeVisible();
      if (closing === 'escape') await page.keyboard.press('Escape');
      // The top-left corner is outside the centered palette: a backdrop click.
      else await page.mouse.click(10, 10);
      await expect(palette(page)).toBeHidden();
    };

    // The first cycle loads and mounts the palette; it is the baseline.
    await cycle('click', 'escape');
    const baseline = await probe(page);
    const baselineDialogs = await page.locator('dialog').count();
    expect(baselineDialogs).toBe(1);

    const plan = [
      ['shortcut', 'escape'],
      ['click', 'backdrop'],
      ['shortcut', 'backdrop'],
      ['click', 'escape'],
      ['shortcut', 'escape'],
    ] as const;
    for (const [opening, closing] of plan) await cycle(opening, closing);

    const after = await probe(page);
    expect(after.listeners).toEqual(baseline.listeners);
    expect(after.showModalCalls).toBe(baseline.showModalCalls + plan.length);
    expect(await page.locator('dialog').count()).toBe(baselineDialogs);
  });

  test('home opens the palette on the first shortcut press, before hydration, once', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-component-page] .dx-hero h1').waitFor();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(searchInput(page)).toBeFocused();
    expect(await showModalCalls(page)).toBe(1);

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeVisible();
    expect(await showModalCalls(page)).toBe(2);
  });

  test('home opens the palette from the trigger before hydration', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-component-page] .dx-hero h1').waitFor();

    await trigger(page).click();
    await expect(searchInput(page)).toBeFocused();
    expect(await showModalCalls(page)).toBe(1);
  });

  for (const [label, path] of [
    ['snapshot', '/page/button?snapshot=1'],
    ['preview', '/page/button?preview=1'],
  ] as const) {
    test(`the ${label} surface has no trigger and no shortcut`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      await expect(trigger(page)).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+k');
      await page.waitForLoadState('networkidle');
      expect(await showModalCalls(page)).toBe(0);
      await expect(page.locator('dialog')).toHaveCount(0);
    });
  }
});

test.describe('390px viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the narrow navigation carries the same trigger, which opens the palette', async ({
    page,
  }) => {
    await openDocumentation(page, '/page/action-row');

    const navigation = page.getByRole('navigation', { name: 'Components' });
    const button = navigation.getByRole('button', { name: TRIGGER_NAME, exact: true });
    await expect(button).toHaveCount(1);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();

    await button.click();
    await expect(searchInput(page)).toBeFocused();
    const panel = await palette(page).boundingBox();
    if (panel === null) throw new Error('The palette is not rendered.');
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  });
});
