import { SvelteSet } from 'svelte/reactivity';
import { velveteenRouteId } from '../src/app/routes.ts';
import { matchRoute, router } from '../src/lib/router.svelte.ts';

type NavigationState = Parameters<typeof router.bindNative>[0];
type Hook = Parameters<NonNullable<NavigationState['registerNavigationHook']>>[1];

function locationAt(url: URL) {
  const matched = matchRoute(url.pathname);
  return {
    url,
    routeId: matched === null ? null : velveteenRouteId(matched.pattern),
    params: Object.fromEntries(
      Object.entries(matched?.params ?? {}).map(([name, value]) => [
        name === '*' ? 'path' : name,
        value,
      ]),
    ),
  };
}

function documentAt(url: URL): NavigationState['page'] {
  const location = locationAt(url);
  return {
    payload: {
      url: url.href,
      routeId: location.routeId,
      params: Object.fromEntries(
        Object.entries(location.params).map(([key, value]) => [key, encodeURIComponent(value)]),
      ),
    },
  };
}

/** A document navigation driver for happy-dom component tests. Real routing is tested in Chromium. */
export function installDocumentNavigation(): void {
  let current = new URL('http://localhost/');
  let page = $state.raw(documentAt(current));
  let shallow = $state.raw<NavigationState['shallow']>(undefined);
  const hooks = {
    before: new SvelteSet<Hook>(),
    on: new SvelteSet<Hook>(),
    after: new SvelteSet<Hook>(),
  };

  function commit(
    destination: URL,
    type: 'goto' | 'popstate' | 'link',
    options: { replace?: boolean; shallow?: boolean } = {},
  ) {
    const next = locationAt(destination);
    let canceled = false;
    const event = {
      from: current,
      to: destination,
      type,
      shallow: options.shallow === true,
      params: next.params,
      routeId: next.routeId,
      cancel() {
        canceled = true;
      },
    };
    for (const hook of hooks.before) void hook(event);
    if (canceled) {
      if (type === 'popstate') window.history.pushState(null, '', current.href);
      return;
    }
    if (type !== 'popstate') {
      if (options.replace) window.history.replaceState(null, '', destination.href);
      else window.history.pushState(null, '', destination.href);
    }
    current = destination;
    if (options.shallow === true) {
      shallow = next;
    } else {
      shallow = undefined;
      page = documentAt(destination);
    }
    for (const hook of hooks.after) void hook(event);
  }

  const state: NavigationState = {
    get page() {
      return page;
    },
    get shallow() {
      return shallow;
    },
    navigation: {
      goto(destination, options) {
        commit(new URL(destination, current), 'goto', options);
        return Promise.resolve();
      },
    },
    registerNavigationHook(stage, callback) {
      hooks[stage].add(callback);
      return () => void hooks[stage].delete(callback);
    },
  };
  router.bindNative(state);
  window.addEventListener('popstate', () => commit(new URL(window.location.href), 'popstate'));
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!target || target.hasAttribute('target') || target.hasAttribute('download')) return;
    const address = target.getAttribute('href');
    if (address === null || !address.startsWith('/')) return;
    const destination = new URL(address, current);
    if (destination.origin !== current.origin) return;
    event.preventDefault();
    commit(destination, 'link');
  });
}
