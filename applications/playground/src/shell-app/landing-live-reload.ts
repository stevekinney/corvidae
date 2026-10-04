/**
 * Live reload for the landing page before its shell hydrates.
 *
 * The landing page hydrates the Svelte shell only on interaction (see
 * `shell-entry.ts`), and the page that subscribes to the dev server's `/events`
 * stream lives inside that shell. Until a reader touches the page, nothing on it
 * would hear a source edit, so the sidebar, prose, styles, and previews would stay
 * stale until a manual refresh. This subscribes from the bootstrap instead, and the
 * entry closes it once the hydrated page has opened its own.
 *
 * It subscribes only where the server advertised a stream (a `cinder-live-reload`
 * `<meta>` tag, written while a dev server is watching its sources). A static
 * export has no such tag and no such stream, so the exported landing page opens
 * nothing.
 */

import { readAdvertisedLiveReloadUrl } from './live-reload-advertisement.ts';

export type LandingLiveReload = {
  /** Stop listening. */
  close(): void;
};

/** The named events the dev server sends: `reload` for example edits, `shell-reload` for the rest. */
const RELOAD_EVENTS = ['reload', 'shell-reload'] as const;

/**
 * Subscribe to the stream `doc` advertises and reload the page when the dev server
 * says its sources changed. Returns `null` when there is nothing to subscribe to.
 */
export function attachLandingLiveReload(
  doc: Document,
  reload: () => void = () => window.location.reload(),
): LandingLiveReload | null {
  if (typeof EventSource === 'undefined') return null;
  const url = readAdvertisedLiveReloadUrl(doc);
  if (url === null) return null;

  const source = new EventSource(url);
  // The first reload tears the page down, so a burst of events behind it queues nothing more.
  let reloading = false;
  const onReload = (): void => {
    if (reloading) return;
    reloading = true;
    reload();
  };
  for (const eventName of RELOAD_EVENTS) source.addEventListener(eventName, onReload);

  return { close: () => source.close() };
}
