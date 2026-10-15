/**
 * Progressive navigation between component pages (CIN-589).
 *
 * A plain click on a canonical component link swaps the target's prerendered document into the
 * current one. Each test names the contract item it pins: no full load, head reconciliation,
 * hydration, history and scroll, focus and announcement, the native fallback, and the guard
 * that keeps a superseded navigation from touching the page.
 */
import { expect, test, type Page, type Request, type Route } from '@playwright/test';

const WARMED_DOCUMENTS = ['/', '/page/button', '/page/chat', '/page/alert'];

// The server renders each document on first request (the featured example runs in its own
// process), which can take longer than an assertion's wait on a busy host. Request every document
// the suite navigates between once, so a click measures the swap and not that first render.
test.beforeAll(async ({ request }) => {
  for (const path of WARMED_DOCUMENTS) await request.get(path);
});

const SURVIVING_MARKER = '__progressiveNavigationMarker';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as Record<string, unknown>)[name] = 'alive';
  }, SURVIVING_MARKER);
}

async function documentSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (name) => (window as unknown as Record<string, unknown>)[name] === 'alive',
    SURVIVING_MARKER,
  );
}

function sidebarLink(page: Page, name: string) {
  return page.locator(`nav.dx-nav a[href="/page/${name}"]`);
}

/** True for the `fetch` the navigator makes, false for a real document navigation. */
function isNavigatorFetch(request: Request): boolean {
  return !request.isNavigationRequest();
}

async function hydratedHeading(page: Page, text: string): Promise<void> {
  await expect(page.locator('#app[data-playground-controls-hydrated]')).toHaveCount(1);
  await expect(page.locator('#app h1').first()).toHaveText(text);
}

/** The stylesheet hrefs the server rendered in the head of `path`. */
async function renderedHeadResources(page: Page, path: string) {
  const response = await page.request.get(path);
  const html = await response.text();
  const head = html.slice(0, html.indexOf('</head>'));
  const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
  return links;
}

async function liveStylesheetHrefs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(
      (link) => new URL(link.getAttribute('href') ?? '', location.href).pathname,
    ),
  );
}

type LiveListener = { target: string; type: string; capture: boolean; signalled: boolean };

/**
 * Track every listener on document and window that is still live: not removed, and not tied to
 * an aborted signal. Call before the first navigation.
 */
async function trackLiveListeners(page: Page): Promise<() => Promise<LiveListener[]>> {
  await page.addInitScript(() => {
    type Registration = {
      target: string;
      type: string;
      capture: boolean;
      signal: AbortSignal | undefined;
      removed: boolean;
    };
    const registrations = new Map<string, Registration>();
    const identities = new WeakMap<object, number>();
    let nextIdentity = 0;
    const identityOf = (listener: object): number => {
      if (!identities.has(listener)) identities.set(listener, nextIdentity++);
      return identities.get(listener)!;
    };
    const keyOf = (target: EventTarget, type: string, listener: object, options: unknown) => {
      const capture =
        typeof options === 'boolean'
          ? options
          : Boolean((options as AddEventListenerOptions)?.capture);
      return `${target === window ? 'window' : 'document'}|${type}|${capture}|${identityOf(listener)}`;
    };
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if ((this === window || this === document) && listener !== null) {
        const key = keyOf(this, type, listener, options);
        if (!registrations.has(key) || registrations.get(key)!.removed) {
          registrations.set(key, {
            target: this === window ? 'window' : 'document',
            type,
            capture: key.split('|')[2] === 'true',
            signal: typeof options === 'object' ? options.signal : undefined,
            removed: false,
          });
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
        const registration = registrations.get(keyOf(this, type, listener, options));
        if (registration) registration.removed = true;
      }
      return remove.call(this, type, listener, options);
    };
    (window as unknown as Record<string, unknown>)['__liveListeners'] = () =>
      [...registrations.values()]
        .filter((entry) => !entry.removed && entry.signal?.aborted !== true)
        .map((entry) => ({
          target: entry.target,
          type: entry.type,
          capture: entry.capture,
          signalled: entry.signal !== undefined,
        }));
  });
  return () =>
    page.evaluate(() =>
      (window as unknown as { __liveListeners: () => LiveListener[] }).__liveListeners(),
    );
}

test.describe('in-page navigation', () => {
  test('a component-to-component click swaps the page without a document load', async ({
    page,
  }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);

    await sidebarLink(page, 'chat').click();

    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');
    await expect(page).toHaveTitle(/^Chat/);
    expect(await documentSurvived(page)).toBe(true);
    expect(await page.locator('#app h1').count()).toBe(1);
    // The page booted under its own address, so the sidebar marks the new entry as current.
    await expect(
      page.getByRole('navigation', { name: 'Components' }).locator('[aria-current="page"]'),
    ).toHaveText('Chat');
  });

  test('the new page hydrates and its interactive controls work', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await sidebarLink(page, 'alert').click();
    await hydratedHeading(page, 'Alert');
    await expect(page.locator('#app[data-playground-controls-hydrated]')).toHaveCount(1);
    // The sidebar filter is live Svelte on the new page.
    await page.locator('#sidebar-filter').fill('toggle');
    await expect(sidebarLink(page, 'toggle')).toBeVisible();
    await expect(sidebarLink(page, 'button')).toHaveCount(0);
  });

  test('stylesheets for the new page are present and the old page is removed', async ({ page }) => {
    const buttonLinks = await renderedHeadResources(page, '/page/button');
    const chatLinks = await renderedHeadResources(page, '/page/chat');
    const chatOnly = chatLinks.filter((href) => !buttonLinks.includes(href));
    expect(chatOnly.length).toBeGreaterThan(0);

    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    const chatOnlyPaths = chatOnly.map((href) => new URL(href, page.url()).pathname);
    expect(await liveStylesheetHrefs(page)).not.toEqual(expect.arrayContaining(chatOnlyPaths));

    await sidebarLink(page, 'chat').click();
    await hydratedHeading(page, 'Chat');
    expect(await liveStylesheetHrefs(page)).toEqual(expect.arrayContaining(chatOnlyPaths));

    await sidebarLink(page, 'button').click();
    await hydratedHeading(page, 'Button');
    const afterReturn = await liveStylesheetHrefs(page);
    for (const href of chatOnlyPaths) expect(afterReturn).not.toContain(href);
    expect(afterReturn.filter((href) => href.endsWith('documentation.css'))).toHaveLength(1);
    expect(await documentSurvived(page)).toBe(true);
  });

  test('back and forward swap the page and restore the saved scroll position', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);

    await sidebarLink(page, 'chat').click();
    await hydratedHeading(page, 'Chat');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/page\/button$/);
    await hydratedHeading(page, 'Button');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);

    await page.goForward();
    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');
    expect(await documentSurvived(page)).toBe(true);
  });

  test('focus lands on the heading and a polite live region announces the page', async ({
    page,
  }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');

    await sidebarLink(page, 'chat').click();
    await hydratedHeading(page, 'Chat');

    await expect(page.locator('#app h1').first()).toBeFocused();
    const announcer = page.locator('[data-navigation-announcer]');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');
    await expect(announcer).toContainText('Chat');
  });

  test('revisiting a page boots the evaluated module again without re-importing it', async ({
    page,
  }) => {
    const entryRequests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (/^\/page-bundle\/[a-z-]+\.js$/.test(pathname)) entryRequests.push(pathname);
    });
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);

    await sidebarLink(page, 'alert').click();
    await hydratedHeading(page, 'Alert');
    await sidebarLink(page, 'button').click();
    await hydratedHeading(page, 'Button');
    await sidebarLink(page, 'alert').click();
    await hydratedHeading(page, 'Alert');

    expect(entryRequests.filter((path) => path === '/page-bundle/button.js')).toHaveLength(1);
    expect(entryRequests.filter((path) => path === '/page-bundle/alert.js')).toHaveLength(1);
    expect(await documentSurvived(page)).toBe(true);
  });

  test('unmounting a page releases its document and window listeners', async ({ page }) => {
    const listeners = await trackLiveListeners(page);
    const liveListeners = async () => {
      const live = await listeners();
      return live.length;
    };

    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await sidebarLink(page, 'alert').click();
    await hydratedHeading(page, 'Alert');
    await sidebarLink(page, 'button').click();
    await hydratedHeading(page, 'Button');
    // One full cycle has run, so every module-level listener (the navigator's, the first
    // evaluation's) is registered. A leak would add listeners on every further cycle.
    const afterFirstCycle = await liveListeners();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await sidebarLink(page, 'alert').click();
      await hydratedHeading(page, 'Alert');
      await sidebarLink(page, 'button').click();
      await hydratedHeading(page, 'Button');
    }

    expect(await liveListeners()).toBe(afterFirstCycle);
  });

  test('the landing page stays registered when it is booted again from the cache', async ({
    page,
  }) => {
    const listeners = await trackLiveListeners(page);
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    const home = () => page.locator('nav.dx-nav a.dx-nav__brand');
    const liveCount = async () => {
      const live = await listeners();
      return live.length;
    };

    // Home, a component, Home again (from the cache), another component, and a second lap.
    const lap = async () => {
      await home().click();
      await expect(page.locator('#shell-root h1')).toHaveCount(1);
      await page.locator('nav.dx-nav a[href="/page/alert"]').click();
      await hydratedHeading(page, 'Alert');
      await home().click();
      await expect(page.locator('#shell-root h1')).toHaveCount(1);
      await page.locator('nav.dx-nav a[href="/page/button"]').click();
      await hydratedHeading(page, 'Button');
    };
    await lap();
    const afterFirstLap = await liveCount();
    await lap();
    await lap();

    // The shell was unmounted each time it left, so its window listeners did not pile up.
    expect(await liveCount()).toBe(afterFirstLap);
    expect(await documentSurvived(page)).toBe(true);
  });

  test('a fragment entry restores its scroll position on Back', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'fragment-probe';
      link.href = '#overview';
      link.textContent = 'overview';
      link.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:white';
      document.body.append(link);
      window.scrollTo(0, 240);
    });
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    await page.locator('#fragment-probe').click();
    await expect(page).toHaveURL(/#overview$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);

    await page.goBack();
    await expect(page).not.toHaveURL(/#overview/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  });

  test('a page whose hydration failed still releases its listeners', async ({ page }) => {
    // Every dynamically imported chunk of the entry fails, so hydration rejects.
    const entry = await page.request.get('/page-bundle/button.js');
    const hashedUrl = /import "([^"]+)"/.exec(await entry.text())?.[1];
    expect(hashedUrl).toBeDefined();
    const hashedResponse = await page.request.get(hashedUrl!);
    const hashed = await hashedResponse.text();
    const chunks = new Set([...hashed.matchAll(/import\("([^"]+)"\)/g)].map((match) => match[1]!));
    expect(chunks.size).toBeGreaterThan(0);
    await page.route('**/page-bundle/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (chunks.has(pathname)) await route.abort('failed');
      else await route.continue();
    });
    const failures: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('failed to hydrate page')) failures.push(message.text());
    });
    const listeners = await trackLiveListeners(page);

    await page.goto('/page/button');
    await expect.poll(() => failures.length).toBeGreaterThan(0);

    // The failed run's capture listeners (which carry an abort signal) are gone.
    const live = await listeners();
    expect(live.filter((entry) => entry.signalled)).toEqual([]);
  });

  test('a stalled stylesheet does not block a later click and leaves nothing behind', async ({
    page,
  }) => {
    const buttonLinks = await renderedHeadResources(page, '/page/button');
    const alertLinks = await renderedHeadResources(page, '/page/alert');
    const chatLinks = await renderedHeadResources(page, '/page/chat');
    const chatOnly = chatLinks
      .filter((href) => !buttonLinks.includes(href) && !alertLinks.includes(href))
      .map((href) => new URL(href, 'http://localhost').pathname);
    expect(chatOnly.length).toBeGreaterThan(0);

    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    const held: Route[] = [];
    await page.route('**/*.css', async (route: Route) => {
      if (chatOnly.includes(new URL(route.request().url()).pathname)) held.push(route);
      else await route.continue();
    });

    await sidebarLink(page, 'chat').click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await sidebarLink(page, 'alert').click();

    await expect(page).toHaveURL(/\/page\/alert$/);
    await hydratedHeading(page, 'Alert');
    const hrefs = await liveStylesheetHrefs(page);
    for (const href of chatOnly) expect(hrefs).not.toContain(href);
    expect(await documentSurvived(page)).toBe(true);
    for (const route of held) await route.abort().catch(() => undefined);
  });

  test('a landing hydration still loading when the page is left does nothing later', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto('/');
    await expect(page.locator('#shell-root h1')).toHaveCount(1);
    await markDocument(page);

    // Hold every shell chunk the toggle's hydration asks for.
    const held: Route[] = [];
    await page.route('**/shell-bundle/**', async (route: Route) => {
      held.push(route);
    });
    await page.locator('button[aria-label^="Preview theme:"]').click();
    await expect.poll(() => held.length).toBeGreaterThan(0);

    await page.unroute('**/shell-bundle/**');
    await page.locator('nav.dx-nav a[href="/page/alert"]').click();
    await hydratedHeading(page, 'Alert');
    for (const route of held) await route.continue().catch(() => undefined);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    expect(problems).toEqual([]);
    expect(await page.locator('#shell-root').count()).toBe(0);
    await expect(page.locator('#app h1')).toHaveCount(1);
    expect(await documentSurvived(page)).toBe(true);
  });

  test('an entry this module did not make gets its own scroll memory', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await page.evaluate(() => window.scrollTo(0, 400));
    const buttonScroll = await page.evaluate(() => window.scrollY);
    expect(buttonScroll).toBeGreaterThan(0);

    await sidebarLink(page, 'alert').click();
    await hydratedHeading(page, 'Alert');
    // Something else rewrote the entry's state, as a foreign pushState would.
    await page.evaluate(() => history.replaceState(null, '', location.href));

    await page.goBack();
    await hydratedHeading(page, 'Button');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(buttonScroll);
    await page.goForward();
    await hydratedHeading(page, 'Alert');
    await page.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120);

    await page.goBack();
    await hydratedHeading(page, 'Button');
    // Alert's offset must not have been written over the button entry's.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(buttonScroll);
  });

  test('the home link swaps to the landing page and back', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);

    await page.locator('nav.dx-nav a.dx-nav__brand').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#shell-root h1')).toHaveCount(1);
    expect(await documentSurvived(page)).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL(/\/page\/button$/);
    await hydratedHeading(page, 'Button');
    expect(await documentSurvived(page)).toBe(true);
  });
});

test.describe('native fallback', () => {
  test('a failed fetch falls back to a full navigation', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    await page.route('**/page/chat', async (route: Route) => {
      if (isNavigatorFetch(route.request())) await route.abort('failed');
      else await route.continue();
    });

    await sidebarLink(page, 'chat').click();

    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');
    expect(await documentSurvived(page)).toBe(false);
  });

  test('a non-2xx response falls back to a full navigation', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    let failedOnce = false;
    await page.route('**/page/chat', async (route: Route) => {
      if (isNavigatorFetch(route.request()) && !failedOnce) {
        failedOnce = true;
        await route.fulfill({ status: 503, body: 'unavailable' });
      } else await route.continue();
    });

    await sidebarLink(page, 'chat').click();

    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');
    expect(await documentSurvived(page)).toBe(false);
  });

  test('a response that is not a playground document falls back to a full navigation', async ({
    page,
  }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    await page.route('**/page/chat', async (route: Route) => {
      if (isNavigatorFetch(route.request())) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>no app</body></html>',
        });
      } else await route.continue();
    });

    await sidebarLink(page, 'chat').click();

    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');
    expect(await documentSurvived(page)).toBe(false);
  });

  test('modified and middle clicks stay native and leave this document alone', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    // Record whether anything claimed each click by the time it reaches the window, then cancel
    // it so the browser does not open tabs: a native click is one nothing prevented.
    await page.evaluate(() => {
      const claimed: boolean[] = [];
      (window as unknown as Record<string, unknown>)['__claimedClicks'] = claimed;
      window.addEventListener('click', (event) => {
        claimed.push(event.defaultPrevented);
        event.preventDefault();
      });
    });
    const readClaims = () =>
      page.evaluate(() =>
        (window as unknown as Record<string, boolean[]>)['__claimedClicks']!.slice(),
      );

    await sidebarLink(page, 'chat').click({ modifiers: ['ControlOrMeta'] });
    await sidebarLink(page, 'chat').click({ modifiers: ['Shift'] });
    await sidebarLink(page, 'chat').click({ modifiers: ['Alt'] });
    expect(await readClaims()).toEqual([false, false, false]);

    // A middle click is an auxclick, which the navigator does not listen to.
    await sidebarLink(page, 'chat').click({ button: 'middle' });
    expect(await readClaims()).toHaveLength(3);

    await expect(page).toHaveURL(/\/page\/button$/);
    await expect(page.locator('#app h1').first()).toHaveText('Button');
    expect(await documentSurvived(page)).toBe(true);

    // The same link without a modifier is claimed, which is what the checks above rule out.
    await sidebarLink(page, 'chat').click();
    await hydratedHeading(page, 'Chat');
    const claims = await readClaims();
    expect(claims.at(-1)).toBe(true);
  });

  test('a link that opens another target stays native', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    await page.evaluate(() => {
      const link = document.querySelector('nav.dx-nav a[href="/page/chat"]');
      link?.setAttribute('target', '_blank');
    });
    const opened = page.context().waitForEvent('page');
    await sidebarLink(page, 'chat').click();
    const popup = await opened;
    await popup.close();
    await expect(page).toHaveURL(/\/page\/button$/);
    expect(await documentSurvived(page)).toBe(true);
  });
});

test.describe('overlapping navigations', () => {
  test('a rapid A to B to C sequence ends on C and never commits B', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await markDocument(page);
    const historyBefore = await page.evaluate(() => history.length);
    const titlesSeen: string[] = [];
    await page.exposeFunction('recordTitle', (title: string) => titlesSeen.push(title));
    await page.evaluate(() => {
      new MutationObserver(() =>
        (window as unknown as { recordTitle: (title: string) => void }).recordTitle(document.title),
      ).observe(document.querySelector('title')!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

    let heldChat: Route | undefined;
    await page.route('**/page/chat', async (route: Route) => {
      if (isNavigatorFetch(route.request())) heldChat = route;
      else await route.continue();
    });
    const chatFetch = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/page/chat',
    );

    await sidebarLink(page, 'chat').click();
    await chatFetch;
    await sidebarLink(page, 'alert').click();

    await expect(page).toHaveURL(/\/page\/alert$/);
    await hydratedHeading(page, 'Alert');

    // B's response now arrives, late, after C committed.
    expect(heldChat).toBeDefined();
    await heldChat!.continue().catch(() => undefined);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    await expect(page).toHaveURL(/\/page\/alert$/);
    await expect(page.locator('#app h1').first()).toHaveText('Alert');
    expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
    expect(titlesSeen.filter((title) => title.startsWith('Chat'))).toEqual([]);
    expect(await documentSurvived(page)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/page\/button$/);
  });

  test('a Back and Forward before the pending page responds never commits it', async ({ page }) => {
    await page.goto('/page/button');
    await hydratedHeading(page, 'Button');
    await sidebarLink(page, 'chat').click();
    await hydratedHeading(page, 'Chat');
    await markDocument(page);
    const titlesSeen: string[] = [];
    await page.exposeFunction('recordTitle', (title: string) => titlesSeen.push(title));
    await page.evaluate(() => {
      new MutationObserver(() =>
        (window as unknown as { recordTitle: (title: string) => void }).recordTitle(document.title),
      ).observe(document.querySelector('title')!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

    let heldButton: Route | undefined;
    await page.route('**/page/button', async (route: Route) => {
      if (isNavigatorFetch(route.request())) heldButton = route;
      else await route.continue();
    });
    const buttonFetch = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/page/button',
    );

    await page.goBack();
    await buttonFetch;
    await page.goForward();
    await expect(page).toHaveURL(/\/page\/chat$/);
    await hydratedHeading(page, 'Chat');

    expect(heldButton).toBeDefined();
    await heldButton!.continue().catch(() => undefined);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    await expect(page).toHaveURL(/\/page\/chat$/);
    await expect(page.locator('#app h1').first()).toHaveText('Chat');
    expect(titlesSeen.filter((title) => title.startsWith('Button'))).toEqual([]);
    expect(await documentSurvived(page)).toBe(true);
  });
});
