/**
 * Locations the design-system build reads from and writes to, resolved from this file so the
 * build runs the same from any working directory and any worktree.
 */

import { join, resolve } from 'node:path';

/** The repository root. */
export const repositoryRoot = resolve(import.meta.dir, '../../../..');
/** The Cinder workspace. */
export const cinderRoot = join(repositoryRoot, 'components/cinder');
/** The editor workspace, whose components the design system documents and bundles with Cinder's. */
export const editorRoot = join(repositoryRoot, 'components/editor');
/** The playground workspace, whose examples the previews mount. */
export const playgroundRoot = join(repositoryRoot, 'applications/playground');
/** One directory per component id, holding its `*.example.svelte` files. */
export const examplesRoot = join(playgroundRoot, 'src/examples');
/** The design-system build's checked-in assets: the brand book and the cover card. */
export const assetsRoot = join(import.meta.dir, 'assets');
/** The default output directory; the publishable folder is its `project/` child. */
export const defaultOutputRoot = join(repositoryRoot, 'tmp/cinder-design-system/out');

/** The repository-relative source paths `tokens.json` records in its `meta`. */
export const sourcePaths = {
  tokens: [
    'components/cinder/src/tokens/resolved/light.json',
    'components/cinder/src/tokens/resolved/dark.json',
  ],
  styles: ['components/cinder/src/styles/all.css'],
  components: ['components/cinder/components.json', 'components/editor/components.json'],
  examples: ['applications/playground/src/examples'],
};
