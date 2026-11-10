/**
 * The collection half of `css-serving-parity.ts`: from the HTML a serving mode renders, work out
 * every stylesheet a browser would fetch, and read each one through a caller-supplied reader. The
 * reader is the only part that differs between the dev server (HTTP) and the static export (files).
 */

import { importSpecifiersOf } from '../../../components/cinder/scripts/css-fingerprint.ts';
import { normalizeStylesheetUrl, type StylesheetRecord } from './css-serving-parity-compare.ts';

const LINK_TAG = /<link\b[^>]*>/gi;

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : value.replaceAll('&amp;', '&');
}

/** The same-origin path of every `<link rel="stylesheet">` in a document. */
export function stylesheetLinks(html: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(LINK_TAG) ?? []) {
    const rel = attribute(tag, 'rel');
    const href = attribute(tag, 'href');
    if (rel === undefined || href === undefined) continue;
    if (!rel.toLowerCase().split(/\s+/).includes('stylesheet')) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    urls.push(normalizeStylesheetUrl(new URL(href, 'https://parity.local/').pathname));
  }
  return urls;
}

/** Reads one stylesheet's text, or `undefined` when the serving mode does not serve it. */
export type StylesheetReader = (url: string) => Promise<string | undefined>;

/**
 * Collect every stylesheet reachable from `entries`: each entry, then every `@import` it makes,
 * transitively, in first-visit order. Remote imports are not stylesheets the playground serves.
 */
export async function collectStylesheets(
  entries: readonly string[],
  read: StylesheetReader,
): Promise<StylesheetRecord> {
  const orderedEntries = [...new Set(entries.map(normalizeStylesheetUrl))].toSorted();
  const files = new Map<string, string>();
  const missing: string[] = [];
  const queued = new Set(orderedEntries);
  const queue = [...orderedEntries];

  for (let index = 0; index < queue.length; index += 1) {
    const url = queue[index]!;
    const text = await read(url);
    if (text === undefined) {
      missing.push(url);
      continue;
    }
    files.set(url, text);
    for (const specifier of importSpecifiersOf(text)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier)) continue;
      const imported = normalizeStylesheetUrl(
        new URL(specifier, `https://parity.local${url}`).pathname,
      );
      if (queued.has(imported)) continue;
      queued.add(imported);
      queue.push(imported);
    }
  }
  return { entries: orderedEntries, files, missing };
}
