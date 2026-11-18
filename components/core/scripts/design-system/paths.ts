/**
 * Locations the design-system build reads from and writes to, resolved from this file so the
 * build runs the same from any working directory and any worktree.
 */

import { join, resolve } from 'node:path';

/** The repository root. */
export const repositoryRoot = resolve(import.meta.dir, '../../../..');
/** The Cinder workspace. */
export const cinderRoot = join(repositoryRoot, 'components/core');
/** The editor workspace, whose components the design system documents and bundles with Cinder's. */
export const editorRoot = join(repositoryRoot, 'components/editor');
/** The playground workspace, whose toolchain bundles the previews. */
export const playgroundRoot = join(repositoryRoot, 'applications/playground');
/** The design-system build's checked-in assets: the brand book, the recipe and the cover card. */
export const assetsRoot = join(import.meta.dir, 'assets');
/** The archetype pages and their shared layout, under the assets. */
export const archetypesRoot = join(assetsRoot, 'archetypes');
/** The default output directory; the publishable folder is its `project/` child. */
export const defaultOutputRoot = join(repositoryRoot, 'tmp/cinder-design-system/out');

/** The repository-relative source paths `tokens.json` records in its `meta`. */
export const sourcePaths = {
  tokens: [
    'components/tokens/src/tokens/resolved/light.json',
    'components/tokens/src/tokens/resolved/dark.json',
  ],
  styles: ['components/core/src/styles/all.css'],
  // Each package's manifest is built from the authored `<name>.meta.json` under these: core's
  // components, those of the packages the split moved them into (P-COR-101), and the editor's.
  components: ['components/*/src/components', 'components/editor/src/lib/components'],
  examples: [
    // Core's components, and those of the packages the split moved them into (P-COR-101).
    'components/*/src/components/*/examples',
    'components/editor/src/lib/components/*/examples',
  ],
};
