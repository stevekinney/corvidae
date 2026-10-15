/**
 * Progressive navigation between the playground's prerendered documents.
 *
 * Every route is a complete static document and every link is a plain `<a href>`, so this module
 * only ever upgrades a navigation the browser would have made anyway. A qualifying click fetches
 * the target document and swaps it in without a full load:
 *
 * 1. add the target's stylesheets to `<head>` and wait for them, so nothing paints unstyled;
 * 2. unmount the current page (its Svelte instance, listeners, streams) through `__CINDER_PAGE__`;
 * 3. swap the container and the data islands, drop the stylesheets the target does not use;
 * 4. push the history entry and title, so the page boots under its own address;
 * 5. import the target's entry on its first visit, or boot the page it already registered;
 * 6. move focus to the heading, announce, and restore scroll.
 *
 * Steps 1 and the fetch can be abandoned by a newer navigation, and a stale response never
 * reaches the URL, document, focus, or history. From step 2 on, the navigation owns the page and
 * finishes: a newer one queues behind it, because a half-swapped document is worse than a short
 * wait. Any failure falls back to a native `location.assign`, and a visit that does not qualify,
 * or a page whose script never ran, is simply a native navigation.
 */

import { headResourceKey, planHeadReconciliation } from './head-reconciliation.ts';
import {
  isCanonicalDocumentPath,
  resolveClickNavigation,
  resolveInPageNavigation,
} from './navigation-eligibility.ts';
import {
  assertCurrent,
  createHistoryGeneration,
  createNavigationSequencer,
  fallbackNavigationMethod,
  SupersededNavigationError,
  type NavigationTicket,
} from './navigation-sequence.ts';

/** What a page entry registers on `window.__CINDER_PAGE__`. */
export type CinderPage = {
  /** Idempotent: hydrates or mounts the page in the current document and resolves when it is live. */
  boot(): Promise<void>;
  /** Idempotent: releases the page's Svelte instance and every listener it added. */
  unmount(): Promise<void>;
};

export type ProgressiveNavigation = {
  /** Swap to `href` in place when it qualifies, or navigate natively when it does not. */
  navigate(href: string): Promise<void>;
};

type NavigationScope = Window & {
  __CINDER_PAGE__?: CinderPage;
  __CINDER_NAVIGATION__?: ProgressiveNavigation;
};

type EntryState = { cinderNavigation: true; id: string };

const ANNOUNCER_ATTRIBUTE = 'data-navigation-announcer';
const GLOBAL_ISLANDS = ['__CINDER_EXAMPLES__', '__CINDER_SIDEBAR__'] as const;
const GLOBAL_ISLAND_PATTERN =
  /^\s*window\.(__CINDER_EXAMPLES__|__CINDER_SIDEBAR__)\s*=\s*([\s\S]*?);\s*$/;
const JSON_ISLAND_IDS = ['cinder-documentation', 'cinder-initial'] as const;
const CONTAINER_IDS = ['app', 'shell-root'] as const;
const METADATA_SELECTOR = [
  'meta[name="description"]',
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'meta[name="cinder-live-reload"]',
  'link[rel="canonical"]',
  'script[type="application/ld+json"]',
].join(',');

type LoadedDocument = {
  url: URL;
  document: Document;
  entryHref: string;
};

type Visit = { kind: 'push' } | { kind: 'pop'; entryId: string | null };

function readEntryState(state: unknown): EntryState | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = state as Partial<EntryState>;
  return candidate.cinderNavigation === true && typeof candidate.id === 'string'
    ? (candidate as EntryState)
    : null;
}

function findContainer(root: Document): HTMLElement | null {
  for (const id of CONTAINER_IDS) {
    const container = root.getElementById(id);
    if (container !== null) return container;
  }
  return null;
}

/** The module URL of the page entry a document loads, or `null` when it names none. */
export function findEntryHref(root: Document, base: string): string | null {
  const source = root.querySelector('script[type="module"][src]')?.getAttribute('src');
  if (source === null || source === undefined) return null;
  const href = new URL(source, base);
  // The static export serves entries from a fingerprinted prefix: /assets/<digest>/page-bundle/...
  return /^(?:\/assets\/[^/]+)?\/(?:page|shell)-bundle\//.test(href.pathname) ? href.href : null;
}

function readGlobalIslands(root: Document): Map<string, unknown> {
  const islands = new Map<string, unknown>();
  for (const script of root.querySelectorAll('script:not([src]):not([type])')) {
    const match = GLOBAL_ISLAND_PATTERN.exec(script.textContent ?? '');
    if (match !== null) islands.set(match[1]!, JSON.parse(match[2]!));
  }
  return islands;
}

function waitForStylesheet(link: HTMLLinkElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void): void => {
      link.removeEventListener('load', onLoad);
      link.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onLoad = (): void => settle(resolve);
    const onError = (): void =>
      settle(() =>
        reject(new Error(`[cinder playground] stylesheet failed to load: ${link.href}`)),
      );
    const onAbort = (): void => settle(() => reject(new SupersededNavigationError()));
    link.addEventListener('load', onLoad);
    link.addEventListener('error', onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);
  });
}

function managedHeadElements(): Map<string, Element> {
  const elements = new Map<string, Element>();
  for (const element of document.head.children) {
    const key = headResourceKey(element, document.baseURI);
    if (key !== null && !elements.has(key)) elements.set(key, element);
  }
  return elements;
}

/**
 * Add the target's missing stylesheets and styles to the head and wait for the links to load.
 * Nothing is removed here.
 */
async function addTargetHead(target: Document, base: string, signal: AbortSignal): Promise<void> {
  const current = managedHeadElements();
  const targetElements = new Map<string, Element>();
  for (const element of target.head.children) {
    const key = headResourceKey(element, base);
    if (key !== null && !targetElements.has(key)) targetElements.set(key, element);
  }
  const { add } = planHeadReconciliation([...current.keys()], [...targetElements.keys()]);
  const loading: Promise<void>[] = [];
  const appended: Element[] = [];
  for (const key of add) {
    const imported = document.importNode(targetElements.get(key)!, true);
    document.head.append(imported);
    appended.push(imported);
    if (imported instanceof HTMLLinkElement) loading.push(waitForStylesheet(imported, signal));
  }
  try {
    await Promise.all(loading);
  } catch (error) {
    // Whatever this call added belongs to a navigation that will not finish.
    for (const element of appended) element.remove();
    throw error;
  }
}

/** Remove the managed resources the target does not use, and replace the page metadata. */
function applyTargetHead(target: Document, base: string): void {
  const targetKeys: string[] = [];
  for (const element of target.head.children) {
    const key = headResourceKey(element, base);
    if (key !== null) targetKeys.push(key);
  }
  const current = managedHeadElements();
  const { remove } = planHeadReconciliation([...current.keys()], targetKeys);
  for (const key of remove) current.get(key)?.remove();

  for (const stale of document.head.querySelectorAll(METADATA_SELECTOR)) stale.remove();
  for (const fresh of target.head.querySelectorAll(METADATA_SELECTOR)) {
    document.head.append(document.importNode(fresh, true));
  }
}

function applyGlobalIslands(islands: Map<string, unknown>): void {
  const scope = window as unknown as Record<string, unknown>;
  for (const name of GLOBAL_ISLANDS) {
    if (islands.has(name)) scope[name] = islands.get(name);
    else delete scope[name];
  }
}

/** Replace the container and the JSON data islands with the target document's. */
function swapBody(target: Document): HTMLElement {
  const incoming = findContainer(target);
  const outgoing = findContainer(document);
  if (incoming === null || outgoing === null) {
    throw new Error('[cinder playground] the document has no #app or #shell-root container');
  }
  for (const id of JSON_ISLAND_IDS) document.getElementById(id)?.remove();
  const adopted = document.importNode(incoming, true);
  outgoing.replaceWith(adopted);
  for (const id of JSON_ISLAND_IDS) {
    const island = target.getElementById(id);
    if (island !== null) adopted.before(document.importNode(island, true));
  }
  return adopted;
}

function ensureAnnouncer(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${ANNOUNCER_ATTRIBUTE}]`);
  if (existing !== null) return existing;
  const announcer = document.createElement('div');
  announcer.setAttribute(ANNOUNCER_ATTRIBUTE, '');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  announcer.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
  document.body.append(announcer);
  return announcer;
}

function moveFocusToPage(container: HTMLElement): void {
  const landmark =
    container.querySelector<HTMLElement>('h1') ??
    container.querySelector<HTMLElement>('main') ??
    container;
  if (!landmark.hasAttribute('tabindex')) landmark.setAttribute('tabindex', '-1');
  landmark.focus({ preventScroll: true });
}

function announce(message: string): void {
  const announcer = ensureAnnouncer();
  announcer.textContent = '';
  // A change to the region's text is what is announced, so the message lands after the clear.
  queueMicrotask(() => {
    announcer.textContent = message;
  });
}

function scrollToHashOrTop(hash: string): void {
  if (hash !== '') {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape: use the text as written.
    }
    const anchor = document.getElementById(id);
    if (anchor !== null) {
      anchor.scrollIntoView();
      return;
    }
  }
  window.scrollTo(0, 0);
}

function isInteractiveFrame(): boolean {
  if (window.self !== window.top) return false;
  const search = new URLSearchParams(window.location.search);
  return search.get('preview') !== '1' && search.get('snapshot') !== '1';
}

/**
 * Install progressive navigation once for the lifetime of the document. Every page entry calls
 * this; a second call, from another entry's copy of this module, returns the first install.
 */
export function installProgressiveNavigation(): ProgressiveNavigation {
  const scope = window as NavigationScope;
  if (scope['__CINDER_NAVIGATION__'] !== undefined) return scope['__CINDER_NAVIGATION__'];

  const native: ProgressiveNavigation = {
    navigate: (href) => {
      window.location.assign(href);
      return Promise.resolve();
    },
  };
  if (!isInteractiveFrame()) return native;

  const sequencer = createNavigationSequencer();
  const pages = new Map<string, CinderPage>();
  const scrollByEntry = new Map<string, number>();
  let currentEntryHref = findEntryHref(document, document.baseURI);
  let currentPath = window.location.pathname;
  let currentEntryId = readEntryState(history.state)?.id ?? crypto.randomUUID();
  let latestRequested = window.location.href;
  let commitQueue: Promise<void> = Promise.resolve();
  // Visits between `visit()` starting and finishing: a history step that returns to the page on
  // screen while one is pending must not be mistaken for a change inside the document.
  let pendingVisits = 0;
  const historyGeneration = createHistoryGeneration();

  history.scrollRestoration = 'manual';
  history.replaceState({ cinderNavigation: true, id: currentEntryId } satisfies EntryState, '');

  function rememberScroll(): void {
    scrollByEntry.set(currentEntryId, window.scrollY);
  }

  async function load(target: URL, ticket: NavigationTicket): Promise<LoadedDocument> {
    const response = await fetch(target, {
      headers: { Accept: 'text/html' },
      signal: ticket.signal,
    });
    if (!response.ok || response.redirected) {
      throw new Error(`[cinder playground] ${target.pathname} answered ${response.status}`);
    }
    const html = await response.text();
    assertCurrent(ticket);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const entryHref = findEntryHref(parsed, target.href);
    if (entryHref === null || findContainer(parsed) === null) {
      throw new Error(`[cinder playground] ${target.pathname} is not a playground document`);
    }
    return { url: target, document: parsed, entryHref };
  }

  async function swapToLoaded(
    loaded: LoadedDocument,
    mode: Visit,
    progress: { historyWritten: boolean; generation: number },
  ): Promise<void> {
    const outgoing = scope['__CINDER_PAGE__'];
    if (outgoing !== undefined && currentEntryHref !== null) pages.set(currentEntryHref, outgoing);
    await outgoing?.unmount();

    const islands = readGlobalIslands(loaded.document);
    const container = swapBody(loaded.document);
    applyGlobalIslands(islands);
    applyTargetHead(loaded.document, loaded.url.href);

    // The address moves before the page boots: the page reads its own location to decide which
    // sidebar entry is current, and hydrating under the old address would mark the wrong one.
    // The reader stepped through history since this visit began, and that step queued its own
    // visit behind this one: let it win rather than write an entry over where they went.
    if (mode.kind === 'push' && historyGeneration.read() !== progress.generation) return;
    if (mode.kind === 'push') {
      progress.historyWritten = true;
      currentEntryId = crypto.randomUUID();
      history.pushState(
        { cinderNavigation: true, id: currentEntryId } satisfies EntryState,
        '',
        loaded.url,
      );
    } else {
      progress.historyWritten = true;
      if (mode.entryId !== null) currentEntryId = mode.entryId;
    }
    currentPath = loaded.url.pathname;
    document.title = loaded.document.title;

    let page = pages.get(loaded.entryHref);
    if (page !== undefined) scope['__CINDER_PAGE__'] = page;
    if (page === undefined) {
      await import(/* webpackIgnore: true */ loaded.entryHref);
      page = scope['__CINDER_PAGE__'];
      if (page === undefined)
        throw new Error('[cinder playground] the page entry did not register');
      pages.set(loaded.entryHref, page);
    }
    currentEntryHref = loaded.entryHref;
    await page.boot();

    moveFocusToPage(container);
    announce(`Navigated to ${loaded.document.title}`);
    if (mode.kind === 'pop' && loaded.url.hash === '') {
      window.scrollTo(0, scrollByEntry.get(currentEntryId) ?? 0);
    } else {
      scrollToHashOrTop(loaded.url.hash);
    }
  }

  async function visit(target: URL, mode: Visit): Promise<void> {
    latestRequested = target.href;
    const ticket = sequencer.begin();
    let ownsPage = false;
    const progress = { historyWritten: mode.kind === 'pop', generation: historyGeneration.read() };
    pendingVisits += 1;
    let release: () => void = () => undefined;
    try {
      const loaded = await load(target, ticket);
      const previous = commitQueue;
      commitQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      assertCurrent(ticket);
      await addTargetHead(loaded.document, loaded.url.href, ticket.signal);
      assertCurrent(ticket);
      // From here the navigation owns the page and runs to the end.
      ownsPage = true;
      await swapToLoaded(loaded, mode, progress);
    } catch (error) {
      if (error instanceof SupersededNavigationError || (!ownsPage && !ticket.isCurrent())) return;
      console.error('[cinder playground] in-page navigation failed; navigating natively:', error);
      window.location[fallbackNavigationMethod(progress.historyWritten)](latestRequested);
    } finally {
      pendingVisits -= 1;
      release();
    }
  }

  /** Tag the history entry on screen when it was made by something other than this module. */
  function adoptEntry(state: EntryState | null): void {
    if (state !== null) {
      currentEntryId = state.id;
      return;
    }
    currentEntryId = tagCurrentEntry();
  }

  /** Give the history entry on screen an id of its own and return it. */
  function tagCurrentEntry(): string {
    const id = crypto.randomUUID();
    history.replaceState({ cinderNavigation: true, id } satisfies EntryState, '');
    return id;
  }

  const navigation: ProgressiveNavigation = {
    navigate(href) {
      const target = resolveInPageNavigation(href, new URL(window.location.href));
      if (target === null) return native.navigate(href);
      rememberScroll();
      return visit(target, { kind: 'push' });
    },
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const target = resolveClickNavigation(
      event,
      {
        href: anchor.href,
        target: anchor.target,
        hasDownload: anchor.hasAttribute('download'),
        rel: anchor.rel,
      },
      new URL(window.location.href),
    );
    if (target === null) return;
    event.preventDefault();
    rememberScroll();
    void visit(target, { kind: 'push' });
  });

  // A native fragment link makes a history entry this module never sees. Save the scroll of the
  // entry it leaves before the browser jumps, and tag the new entry once it exists, so a later
  // Back finds an offset to restore (manual restoration turns the browser's own off).
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const sameDocument =
        anchor.origin === window.location.origin &&
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search;
      if (sameDocument && anchor.hash !== '') rememberScroll();
    },
    { capture: true },
  );

  window.addEventListener('hashchange', () => {
    if (readEntryState(history.state) === null) adoptEntry(null);
  });

  window.addEventListener('popstate', (event) => {
    historyGeneration.advance();
    const destination = new URL(window.location.href);
    rememberScroll();
    const state = readEntryState(event.state);
    // A step to another entry of the document on screen is not a document change, unless a
    // visit is still pending: then the pending one must be superseded, or it would commit over
    // the page the reader just returned to.
    if (destination.pathname === currentPath && pendingVisits === 0) {
      adoptEntry(state);
      const saved = scrollByEntry.get(currentEntryId);
      if (saved !== undefined) window.scrollTo(0, saved);
      else if (destination.hash !== '') scrollToHashOrTop(destination.hash);
      return;
    }
    if (!isCanonicalDocumentPath(destination.pathname) || destination.search !== '') {
      window.location.assign(destination.href);
      return;
    }
    // An entry this module did not make has no id yet. Give it one now, or the page that
    // replaces the current one would keep this page's id and share its scroll memory.
    void visit(destination, { kind: 'pop', entryId: state?.id ?? tagCurrentEntry() });
  });

  scope['__CINDER_NAVIGATION__'] = navigation;
  return navigation;
}

/** The installed navigation, or `null` when no page entry has installed one. */
export function readInstalledNavigation(scope: Window = window): ProgressiveNavigation | null {
  return (scope as NavigationScope)['__CINDER_NAVIGATION__'] ?? null;
}
