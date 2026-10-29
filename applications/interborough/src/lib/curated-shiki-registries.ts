/**
 * The grammars and themes `@lostgradient/chat`'s highlighter can find in the built application.
 *
 * Chat publishes Cinder's `fullShikiHighlighter()` for every code block in a transcript, and that
 * highlighter looks a block's language up in `shiki/langs` and `shiki/themes`, whose complete
 * registries would make a bundler emit every grammar and theme Shiki ships. The build resolves
 * both specifiers to this module instead (`curatedShikiPlugin` in `scripts/build.ts`), so the
 * tables hold what the application already ships: the grammars Markdown highlights with
 * (`BUNDLED_LANGUAGES` in `packages/markdown/src/rendering/highlighter.ts`) and the grammars those
 * embed, which include JSON, the language of every tool call's arguments and result, and the two
 * GitHub themes the console's own highlighter uses (`./code-highlighter.ts`).
 *
 * A language outside the tables renders as plain text, with a console warning, as it would for
 * Shiki itself. Adding one is a line here and a line in the grammar list `build.slow.test.ts`
 * holds, which is what keeps the bundle's size a decision.
 */
const grammars = {
  bash: () => import('@shikijs/langs/bash'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  html: () => import('@shikijs/langs/html'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  postcss: () => import('@shikijs/langs/postcss'),
  python: () => import('@shikijs/langs/python'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  typescript: () => import('@shikijs/langs/typescript'),
  yaml: () => import('@shikijs/langs/yaml'),
};

/** The grammars by the names a Markdown fence uses, aliases included. */
export const bundledLanguages = {
  ...grammars,
  js: grammars.javascript,
  md: grammars.markdown,
  py: grammars.python,
  sh: grammars.shellscript,
  shell: grammars.shellscript,
  ts: grammars.typescript,
  yml: grammars.yaml,
  zsh: grammars.shellscript,
};

/** The Shiki themes the page bundles, each loaded on first use. */
export const bundledThemes = {
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'github-light': () => import('@shikijs/themes/github-light'),
};
