/**
 * Entry point for the playground shell SPA bundle.
 *
 * Adds the small progressive enhancements the server-rendered landing page
 * needs. The full Svelte shell is intentionally not hydrated here: its
 * documentation and editor graph belongs behind reader interaction, not in the
 * first landing-page transfer.
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
import { attachDeferredToggle } from './deferred-toggle.ts';
import { attachLandingLiveReload } from './landing-live-reload.ts';
import { memoizeUntilRejected } from './retryable-promise.ts';
import { persistScrollPosition } from './sidebar-scroll.ts';

applyColorTokenOverridesToDocument(document, readSessionColorTokenOverrides()[readInitialTheme()]);

// The shell hydrates on interaction, so until then nothing else on this page would hear the
// dev server's reload events. The hydrated page opens its own stream; this one closes with it.
const landingLiveReload = attachLandingLiveReload(document);

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
  followSystemTheme((systemTheme) => {
    applyColorTokenOverridesToDocument(document, readSessionColorTokenOverrides()[systemTheme]);
    themeToggle.setAttribute('aria-label', labelForTheme(systemTheme));
    void hydrateShell().catch((error) =>
      console.error('[cinder playground] failed to synchronize landing theme:', error),
    );
  });
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
    svelte.hydrate(shellModule.default, {
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

const sidebarNavigation = document.querySelector<HTMLElement>('nav.dx-nav');
if (sidebarNavigation !== null) persistScrollPosition(sidebarNavigation);

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
