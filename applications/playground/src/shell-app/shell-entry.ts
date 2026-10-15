/**
 * Entry point for the playground shell SPA bundle.
 *
 * Adds the small progressive enhancements the server-rendered landing page
 * needs. The full Svelte shell is intentionally not hydrated here: its
 * documentation and editor graph belongs behind reader interaction, not in the
 * first landing-page transfer.
 *
 * The entry follows the page contract (`window.__CINDER_PAGE__`): `boot()` attaches everything and
 * is idempotent, `unmount()` releases the window-level listeners, the live-reload stream, the
 * system-theme subscription, and the hydrated shell, so a navigation can swap another document in.
 */

import {
  applyTheme,
  followSystemTheme,
  NAV_FILTER_STORAGE_KEY,
  readInitialTheme,
} from '../component-page-theme.ts';
import {
  applyColorTokenOverridesToDocument,
  readSessionColorTokenOverrides,
} from './color-token-overrides.ts';
import {
  COMPONENT_SEARCH_LISTENING_ATTRIBUTE,
  COMPONENT_SEARCH_TRIGGER_ATTRIBUTE,
  isComponentSearchShortcut,
} from './component-search-shortcut.ts';
import { attachDeferredShortcut } from './deferred-shortcut.ts';
import { attachDeferredToggle } from './deferred-toggle.ts';
import { attachLandingLiveReload } from './landing-live-reload.ts';
import { installProgressiveNavigation, type CinderPage } from './progressive-navigation.ts';
import { memoizeUntilRejected } from './retryable-promise.ts';
import { persistScrollPosition } from './sidebar-scroll.ts';

function attachLandingPage(): ShellRun {
  applyColorTokenOverridesToDocument(
    document,
    readSessionColorTokenOverrides()[readInitialTheme()],
  );

  // The shell hydrates on interaction, so until then nothing else on this page would hear the
  // dev server's reload events. The hydrated page opens its own stream; this one closes with it.
  const landingLiveReload = attachLandingLiveReload(document);
  const teardown = new AbortController();
  let hydratedShell: Record<string, unknown> | undefined;
  let svelteRuntime: typeof import('svelte') | undefined;
  const releases: Array<() => void> = [() => landingLiveReload?.close()];

  const themeToggle = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Preview theme:"]',
  );

  function labelForTheme(theme: 'light' | 'dark'): string {
    return theme === 'dark' ? 'Preview theme: switch to light' : 'Preview theme: switch to dark';
  }

  if (themeToggle !== null) {
    themeToggle.addEventListener('click', () => {
      const nextTheme = readInitialTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
      applyColorTokenOverridesToDocument(document, readSessionColorTokenOverrides()[nextTheme]);
      themeToggle.setAttribute('aria-label', labelForTheme(nextTheme));
      void hydrateShell().catch((error) =>
        console.error('[cinder playground] failed to hydrate landing shell:', error),
      );
    });
  }

  // While the reader has chosen no theme the page follows the operating system, so a change there
  // must reach the toggle and the session color overrides the way a click on the toggle does. The
  // hydrated shell follows the system itself; this covers the page until then.
  if (themeToggle !== null) {
    const stopFollowingSystemTheme = followSystemTheme((systemTheme) => {
      applyColorTokenOverridesToDocument(document, readSessionColorTokenOverrides()[systemTheme]);
      themeToggle.setAttribute('aria-label', labelForTheme(systemTheme));
      void hydrateShell().catch((error) =>
        console.error('[cinder playground] failed to synchronize landing theme:', error),
      );
    });
    releases.push(stopFollowingSystemTheme);
  }

  let shellHydrated = false;

  function hydrateShellOnce(): Promise<void> {
    return Promise.all([
      import('svelte'),
      import('./shell-initial-data.ts'),
      import('./shell.svelte'),
    ]).then(([svelte, initialDataModule, shellModule]) => {
      const target = document.getElementById('shell-root');
      if (target === null) throw new Error('[cinder playground] #shell-root target not found');

      const node = document.getElementById('cinder-initial');
      let rawInitialData: unknown = {};
      try {
        rawInitialData = node === null ? {} : JSON.parse(node.textContent ?? '{}');
      } catch (error) {
        console.error('[cinder playground] failed to parse #cinder-initial:', error);
      }
      let initial = initialDataModule.parseInitialData(rawInitialData);
      if (initial === null) {
        initial = {
          component: '',
          components: [],
          readmeHtml: '',
          documentation: null,
          initialSearch: '',
        };
      }
      svelteRuntime = svelte;
      hydratedShell = svelte.hydrate(shellModule.default, {
        target,
        props: {
          components: initial.components,
          readmeHtml: initial.readmeHtml,
        },
      });
      shellHydrated = true;
      landingLiveReload?.close();
      return undefined;
    });
  }

  // A failed attempt is forgotten so the next caller retries; a memoized rejection
  // would leave the deferred toolbar controls inert until the page reloaded.
  const hydrateShell = memoizeUntilRejected(hydrateShellOnce);

  // Static SSR always renders the light-state icon to avoid hydration mismatch.
  // A persisted dark theme needs the interactive control immediately so its icon
  // and accessible label match the pre-paint theme before the first click.
  if (themeToggle !== null && readInitialTheme() === 'dark') {
    void hydrateShell().catch((error) =>
      console.error('[cinder playground] failed to synchronize landing theme:', error),
    );
  }

  /**
   * Every panel trigger in the toolbar needs `attachDeferredToggle`, so it is a
   * function rather than a block per button — adding a trigger without its
   * bootstrap produces a button that silently does nothing until some OTHER
   * control happens to hydrate the shell first, which is a genuinely confusing
   * failure to debug.
   */
  function bootstrapDeferredToggle(accessibleName: string): void {
    attachDeferredToggle(
      document.querySelector<HTMLButtonElement>(`button[aria-label="${accessibleName}"]`),
      {
        hydrate: hydrateShell,
        isHydrated: () => shellHydrated,
        onError: (error) =>
          console.error('[cinder playground] failed to hydrate landing shell:', error),
      },
    );
  }

  /*
   * Selected by accessible name rather than `data-testid`: this is runtime
   * behaviour, and keying it off a testing affordance means renaming that
   * attribute silently makes a toolbar button inert until some other control
   * happens to hydrate the shell. The theme toggle above and the panels' own
   * focus restoration already select on the accessible name for the same reason.
   */
  bootstrapDeferredToggle('Color token panel');
  bootstrapDeferredToggle('Token inspector');

  /** The sidebar's "Search components" button, found by its own runtime hook inside the sidebar. */
  function findComponentSearchTrigger(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `nav.dx-nav button[${COMPONENT_SEARCH_TRIGGER_ATTRIBUTE}]`,
    );
  }

  const componentSearchTrigger = findComponentSearchTrigger();
  attachDeferredToggle(componentSearchTrigger, {
    hydrate: hydrateShell,
    isHydrated: () => shellHydrated,
    onError: (error) =>
      console.error('[cinder playground] failed to hydrate landing shell:', error),
  });

  // The hydrated sidebar owns Cmd/Ctrl+K once its listener marks the trigger; until
  // then a press hydrates the shell (or reuses the finished hydration) and opens the
  // palette through its trigger, exactly once. Keying the hand-off on that mark
  // rather than on hydration leaves no gap between the two listeners.
  if (componentSearchTrigger !== null) {
    attachDeferredShortcut(window, {
      matches: (event) => isComponentSearchShortcut(event, document),
      hydrate: hydrateShell,
      signal: teardown.signal,
      isLiveListenerAttached: () =>
        findComponentSearchTrigger()?.hasAttribute(COMPONENT_SEARCH_LISTENING_ATTRIBUTE) === true,
      activate: () => findComponentSearchTrigger()?.click(),
      onError: (error) =>
        console.error('[cinder playground] failed to hydrate landing shell:', error),
    });
  }

  const sidebarNavigation = document.querySelector<HTMLElement>('nav.dx-nav');
  if (sidebarNavigation !== null) {
    const release = persistScrollPosition(sidebarNavigation);
    if (typeof release === 'function') releases.push(release);
  }

  const sidebarFilter = document.getElementById('sidebar-filter');
  if (sidebarFilter instanceof HTMLInputElement) {
    let latestFilterValue = '';
    try {
      latestFilterValue = sessionStorage.getItem(NAV_FILTER_STORAGE_KEY) ?? '';
      sidebarFilter.value = latestFilterValue;
    } catch {
      // Private mode or disabled storage: filtering still works for this page.
    }
    const persistAndHydrateFilter = () => {
      latestFilterValue = sidebarFilter.value;
      try {
        sessionStorage.setItem(NAV_FILTER_STORAGE_KEY, latestFilterValue);
      } catch {
        // Private mode or disabled storage: keep the current input value.
      }
      void hydrateShell()
        .then(() => {
          sidebarFilter.removeEventListener('input', persistAndHydrateFilter);
          const hydratedFilter = document.getElementById('sidebar-filter');
          if (!(hydratedFilter instanceof HTMLInputElement)) return undefined;
          hydratedFilter.value = latestFilterValue;
          hydratedFilter.dispatchEvent(new Event('input', { bubbles: true }));
          return undefined;
        })
        .catch((error) =>
          console.error('[cinder playground] failed to hydrate landing shell:', error),
        );
    };
    sidebarFilter.addEventListener('input', persistAndHydrateFilter);

    if (latestFilterValue !== '') {
      void hydrateShell().catch((error) =>
        console.error('[cinder playground] failed to restore landing filter:', error),
      );
    }
  }

  return {
    unmount: async () => {
      teardown.abort();
      for (const release of releases) release();
      if (hydratedShell !== undefined && svelteRuntime !== undefined) {
        await svelteRuntime.unmount(hydratedShell);
        hydratedShell = undefined;
      }
    },
  };
}

type ShellRun = { unmount: () => Promise<void> };
let activeRun: ShellRun | undefined;

const page: CinderPage = {
  boot() {
    // Registered on every boot, not once at evaluation: the navigator boots this cached module
    // again after other pages replaced the handle, and unmounts whatever the handle names.
    (window as unknown as { __CINDER_PAGE__?: CinderPage })['__CINDER_PAGE__'] = page;
    activeRun ??= attachLandingPage();
    return Promise.resolve();
  },
  unmount() {
    const run = activeRun;
    activeRun = undefined;
    return run === undefined ? Promise.resolve() : run.unmount();
  },
};

(window as unknown as { __CINDER_PAGE__?: CinderPage })['__CINDER_PAGE__'] = page;
installProgressiveNavigation();
void page.boot();
