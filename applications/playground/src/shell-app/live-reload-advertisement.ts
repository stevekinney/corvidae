/**
 * How a page learns that the server it came from has a live-reload stream.
 *
 * A dev server that is watching its sources writes a `cinder-live-reload` `<meta>`
 * tag into the head of the pages it renders (`liveReloadMetaTag` in
 * `render-shell.ts`), and the page subscribes to the address the tag names. A page
 * rendered without a live server, which is every page the static export writes,
 * carries no tag, so it opens no stream: a static host has nothing to answer one
 * with.
 */

/** The `name` of the `<meta>` tag that advertises the stream. */
export const LIVE_RELOAD_META_NAME = 'cinder-live-reload';

/** The address of the live-reload stream `doc` advertises, or `null` when it advertises none. */
export function readAdvertisedLiveReloadUrl(doc: Document): string | null {
  const url = doc.querySelector(`meta[name="${LIVE_RELOAD_META_NAME}"]`)?.getAttribute('content');
  return url === null || url === undefined || url === '' ? null : url;
}
