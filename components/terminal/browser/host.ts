import {
  fullShikiHighlighter,
  guardThemeTransitions,
  setCodeHighlighterContext,
} from '@lostgradient/cinder';
import type { FixtureHostOptions } from '@lostgradient/testing/browser/host';

/**
 * How the terminal's fixture page mounts a fixture: the theme guard an application installs, and
 * the full-registry code highlighter the root suite rendered the terminal's baselines with.
 */
export default {
  installThemeGuard: guardThemeTransitions,
  provideContext: () => setCodeHighlighterContext(fullShikiHighlighter()),
} satisfies Omit<FixtureHostOptions, 'modules'>;
