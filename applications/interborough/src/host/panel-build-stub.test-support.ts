/**
 * The panel build a host started by a fast-lane test uses (COR-2219). A real build bundles Svelte
 * and Cinder for each of the default plugins' panels, which is seconds of work that a test of the
 * Settings page or the audit retention never looks at, and `--parallel` gives every test file its
 * own process, so no file can borrow another's build. This builder answers the same request with a
 * small page and bundles nothing: the panels stay mounted, listed and served.
 *
 * It keeps the two properties a host test observes of a build. An entry that cannot be read fails,
 * as a build of it would, and the page carries a digest of the entry's bytes, so a changed entry is
 * a changed page. A test of the build itself is in `panel-build.slow.test.ts` and
 * `panel-inspectors.slow.test.ts`.
 */
import { fileURLToPath } from 'node:url';

import { digestOf, type PanelPageBuilder } from './panel-build.ts';

/** Escape text placed in an element or a quoted attribute. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The stub page of `request`: its title, its plugin styles and a digest of its entry's bytes. */
export const stubPanelBuild: PanelPageBuilder = async ({ entry, title, styles }) => {
  const entryPath = fileURLToPath(entry);
  const entryDigest = digestOf(await Bun.file(entryPath).text());
  const html = `<meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${styles.replaceAll('</style', '<\\/style')}</style><div id="root"></div><meta name="stub-panel" content="${entryDigest}">`;
  // No `inputs`: the cache stores a page only with the files it was built from, and this is cheaper
  // to make again than to store.
  return { html, contentDigest: digestOf(html) };
};
