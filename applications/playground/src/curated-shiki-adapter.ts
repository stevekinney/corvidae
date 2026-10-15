/**
 * The highlighter the playground publishes for every component it mounts.
 *
 * Cinder's `<CodeBlock>` imports no highlighter of its own: it highlights with
 * its `highlighter` prop, else with the one an ancestor publishes through
 * `setCodeHighlighterContext`, else not at all. The playground mounts every
 * example, live preview, and fixture beneath `code-highlighter-root.svelte`,
 * which publishes this one.
 *
 * It is built on Cinder's curated `shikiHighlighter` rather than
 * `fullShikiHighlighter`, because the full registry is 253 grammars and 65
 * themes, 9.8 MB of source against 1.2 MB for the entire rest of a page's
 * graph. The playground compiles one bundle per component, so walking that
 * registry 179 times took its eager pre-build to 18 GB resident (CIN-523).
 *
 *   - Languages narrow to `BUNDLED_LANGUAGE_LOADERS`, the same curated set
 *     `@lostgradient/markdown` uses for README fences. Anything outside it
 *     renders as escaped plaintext with one `console.warn`, never a throw —
 *     the adapter's own documented contract.
 *   - Themes narrow to `github-light` and `github-dark`, the pair the adapter
 *     applies when no `theme` option is given.
 *
 * Chat's own pages are the exception by design: `<Chat>` publishes the full
 * registry for its subtree, so the few pages that render it walk it.
 *
 * @module
 */

import { type Highlighter, shikiHighlighter } from '@lostgradient/cinder';
import { BUNDLED_LANGUAGE_LOADERS } from '@lostgradient/markdown';

/**
 * The two themes the adapter resolves by name when no `theme` option is
 * given. Loading them individually is what keeps this off `shiki/themes`.
 */
const DEFAULT_THEME_LOADERS = {
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
};

/**
 * One module-scoped instance, so every mounted component shares one Shiki
 * module and the grammars it has loaded.
 */
export const curatedCodeHighlighter: Highlighter = shikiHighlighter({
  languageLoaders: BUNDLED_LANGUAGE_LOADERS,
  themeLoaders: DEFAULT_THEME_LOADERS,
});
