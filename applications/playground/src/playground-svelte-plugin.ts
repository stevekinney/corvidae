import {
  compileSvelteComponentForBun,
  compileSvelteRuneModuleForBun,
  preserveServerComponentIdentity,
  type SvelteGenerationTarget,
} from '@lostgradient/testing';
import type { BunPlugin } from 'bun';

const PLAYGROUND_SOURCE_MARKER = '/applications/playground/';

/**
 * Whether `path` is playground chrome: the documentation page, shell, and
 * examples. These are dev-only scaffolding, not part of the design-system
 * cascade, so they carry their own scoped styles.
 */
export function isPlaygroundPath(path: string): boolean {
  return path.replaceAll('\\', '/').includes(PLAYGROUND_SOURCE_MARKER);
}

/**
 * Keep a component's identity through a production server compile. Svelte's
 * `$$renderer.component()` calls need the compiled component as a second
 * argument for the server output to hydrate against the client's; development
 * compiles do not.
 */
export function transformPlaygroundServerOutput({
  code,
  path,
  dev,
}: {
  code: string;
  path: string;
  dev: boolean;
}): string {
  return dev ? code : preserveServerComponentIdentity(code, path);
}

/**
 * The Svelte compiler plugin every playground build uses.
 *
 * The shared test plugin compiles with `css: 'external'` unless `injectCss` is
 * set and discards the external CSS, which is right for library components
 * (their CSS ships as sidecar files) and wrong for playground chrome: its
 * scoped styles would never reach the server-rendered `head`, leaving the
 * landing page and documentation pages unstyled until the client bundle
 * loaded. Playground files therefore always inject their CSS, and every other
 * component follows `injectCss`. A production server compile also keeps
 * component identity (see {@link transformPlaygroundServerOutput}).
 */
export function playgroundSveltePlugin(options: {
  generate: SvelteGenerationTarget;
  injectCss?: boolean;
}): BunPlugin {
  const { generate } = options;
  const injectCss = options.injectCss ?? false;

  return {
    name: `playground-svelte-${generate}`,
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) =>
        compileSvelteComponentForBun(
          await Bun.file(path).text(),
          path,
          { generate, injectCss: injectCss || isPlaygroundPath(path) },
          { transformServerOutput: transformPlaygroundServerOutput },
        ),
      );

      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) =>
        compileSvelteRuneModuleForBun(await Bun.file(path).text(), path, generate),
      );
    },
  };
}
