import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileSvelteComponentForBun } from '@lostgradient/testing';
import type { BunPlugin, OnLoadResult } from 'bun';

import { CINDER_COMPONENT_SOURCE, EDITOR_COMPONENT_SOURCE } from './component-sources.ts';
import { PLAYGROUND_ROOT } from './playground-paths.ts';
import {
  isPlaygroundPath,
  playgroundCompilerFingerprint,
  playgroundSveltePlugin,
  transformPlaygroundServerOutput,
} from './playground-svelte-plugin.ts';
import { createSvelteCompileCache } from './svelte-compile-cache.ts';

// Authored with a scoped `<style>` block, so compiling it with CSS injection leaves the
// `$$css` record Svelte attaches to the module (and adds to the SSR head on render).
const PLAYGROUND_STYLED_COMPONENT = `${PLAYGROUND_ROOT}/src/component-page.svelte`;
const LIBRARY_STYLED_COMPONENT = `${EDITOR_COMPONENT_SOURCE.componentsRoot}/diff-viewer/diff-viewer.svelte`;
const INJECTED_CSS_MARKER = 'const $$css = {';

type LoadHandler = (arguments_: { path: string }) => Promise<OnLoadResult>;

/** Run the plugin's `onLoad` handlers against a real file, as `Bun.build` would. */
async function compileThrough(plugin: BunPlugin, path: string): Promise<string> {
  const handlers: { filter: RegExp; handler: LoadHandler }[] = [];
  await plugin.setup({
    onLoad: (constraints: { filter: RegExp }, handler: LoadHandler) => {
      handlers.push({ filter: constraints.filter, handler });
    },
  } as unknown as Parameters<BunPlugin['setup']>[0]);
  const match = handlers.find(({ filter }) => filter.test(path));
  if (match === undefined) throw new Error(`no handler for ${path}`);
  const result = await match.handler({ path });
  if (typeof result === 'object' && result !== null && 'contents' in result) {
    const { contents } = result;
    if (typeof contents === 'string') return contents;
  }
  throw new Error(`the handler for ${path} returned no source text`);
}

async function compileWithTestingDefaults(path: string): Promise<string> {
  return compileSvelteComponentForBun(
    await Bun.file(path).text(),
    path,
    { generate: 'server', injectCss: false },
    {},
  ).contents;
}

const NODE_ENV_RESTORER = (() => {
  const original = process.env['NODE_ENV'];
  return () => {
    if (original === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = original;
  };
})();

afterEach(NODE_ENV_RESTORER);

describe('isPlaygroundPath', () => {
  it('recognizes files under the application and nothing else', () => {
    expect(isPlaygroundPath(`${PLAYGROUND_ROOT}/src/component-page.svelte`)).toBe(true);
    expect(isPlaygroundPath('C:\\work\\corvidae\\applications\\playground\\src\\a.svelte')).toBe(
      true,
    );
    expect(isPlaygroundPath(LIBRARY_STYLED_COMPONENT)).toBe(false);
    expect(isPlaygroundPath(`${PLAYGROUND_ROOT}-sibling/src/a.svelte`)).toBe(false);
    expect(isPlaygroundPath(`${CINDER_COMPONENT_SOURCE.packageRoot}/src/index.ts`)).toBe(false);
  });
});

describe('playgroundSveltePlugin', () => {
  it('shows why the shared test plugin is not enough: its server compile drops the CSS', async () => {
    expect(await compileWithTestingDefaults(PLAYGROUND_STYLED_COMPONENT)).not.toContain(
      INJECTED_CSS_MARKER,
    );
  });

  it('injects playground chrome styles into a server compile that did not ask for CSS', async () => {
    const plugin = playgroundSveltePlugin({ generate: 'server' });

    expect(await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT)).toContain(
      INJECTED_CSS_MARKER,
    );
  });

  it('leaves library components to their own CSS delivery unless injection is requested', async () => {
    const withoutInjection = playgroundSveltePlugin({ generate: 'server' });
    const withInjection = playgroundSveltePlugin({ generate: 'server', injectCss: true });

    expect(await compileThrough(withoutInjection, LIBRARY_STYLED_COMPONENT)).not.toContain(
      INJECTED_CSS_MARKER,
    );
    expect(await compileThrough(withInjection, LIBRARY_STYLED_COMPONENT)).toContain(
      INJECTED_CSS_MARKER,
    );
  });

  it('keeps component identity across a production server compile only', async () => {
    const plugin = playgroundSveltePlugin({ generate: 'server' });
    // The compiled component's own function, passed as the boundary's second argument.
    const identityPattern = /\},\s*[A-Z][\w$]*\)/;

    process.env['NODE_ENV'] = 'production';
    const production = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);
    process.env['NODE_ENV'] = 'development';
    const development = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);

    expect(identityPattern.test(production)).toBe(true);
    expect(identityPattern.test(development)).toBe(false);
  });
});

describe('playgroundSveltePlugin compile cache', () => {
  function withCacheDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), 'playground-svelte-plugin-cache-'));
    return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
  }

  function cacheAt(directory: string) {
    return createSvelteCompileCache({ directory, compilerFingerprint: 'test-compiler' });
  }

  it('serves a component compiled earlier from disk, byte for byte what the compiler produced', async () => {
    await withCacheDirectory(async (directory) => {
      const uncached = await compileThrough(
        playgroundSveltePlugin({ generate: 'server', cache: null }),
        PLAYGROUND_STYLED_COMPONENT,
      );

      const first = await compileThrough(
        playgroundSveltePlugin({ generate: 'server', cache: cacheAt(directory) }),
        PLAYGROUND_STYLED_COMPONENT,
      );
      // A new plugin and a new cache instance on the same directory, as a fresh process is.
      const second = await compileThrough(
        playgroundSveltePlugin({ generate: 'server', cache: cacheAt(directory) }),
        PLAYGROUND_STYLED_COMPONENT,
      );

      expect(readdirSync(directory)).toHaveLength(1);
      expect(first).toBe(uncached);
      expect(second).toBe(uncached);
    });
  });

  it('keeps production and development output apart, so a cache filled in one never serves the other', async () => {
    await withCacheDirectory(async (directory) => {
      const plugin = playgroundSveltePlugin({ generate: 'server', cache: cacheAt(directory) });
      const identityPattern = /\},\s*[A-Z][\w$]*\)/;

      process.env['NODE_ENV'] = 'production';
      const production = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);
      process.env['NODE_ENV'] = 'development';
      const development = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);
      process.env['NODE_ENV'] = 'production';
      const productionAgain = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);
      process.env['NODE_ENV'] = 'development';
      const developmentAgain = await compileThrough(plugin, PLAYGROUND_STYLED_COMPONENT);

      expect(identityPattern.test(production)).toBe(true);
      expect(identityPattern.test(development)).toBe(false);
      expect(productionAgain).toBe(production);
      expect(developmentAgain).toBe(development);
      expect(readdirSync(directory)).toHaveLength(2);
    });
  });

  it('keeps client and server output, and injected and external CSS, apart', async () => {
    await withCacheDirectory(async (directory) => {
      const variants = [
        { generate: 'server', injectCss: false },
        { generate: 'server', injectCss: true },
        { generate: 'client', injectCss: false },
        { generate: 'client', injectCss: true },
      ] as const;

      const outputs = new Set<string>();
      for (const variant of variants) {
        const plugin = playgroundSveltePlugin({ ...variant, cache: cacheAt(directory) });
        outputs.add(await compileThrough(plugin, LIBRARY_STYLED_COMPONENT));
      }

      expect(outputs.size).toBe(variants.length);
      expect(readdirSync(directory)).toHaveLength(variants.length);
    });
  });
});

describe('playgroundCompilerFingerprint', () => {
  const inputs = {
    svelteVersion: '5.57.0',
    bunVersion: '1.4.2',
    pluginSource: 'plugin code',
    testingPluginSource: 'testing plugin code',
  };

  it('is stable for the same inputs', () => {
    expect(playgroundCompilerFingerprint(inputs)).toBe(
      playgroundCompilerFingerprint({ ...inputs }),
    );
  });

  it.each(Object.keys(inputs) as (keyof typeof inputs)[])('changes when %s changes', (name) => {
    expect(
      playgroundCompilerFingerprint({ ...inputs, [name]: `${inputs[name]} changed` }),
    ).not.toBe(playgroundCompilerFingerprint(inputs));
  });

  it('does not let one input bleed into the next', () => {
    expect(
      playgroundCompilerFingerprint({ ...inputs, svelteVersion: 'a', bunVersion: 'bc' }),
    ).not.toBe(playgroundCompilerFingerprint({ ...inputs, svelteVersion: 'ab', bunVersion: 'c' }));
  });
});

describe('transformPlaygroundServerOutput', () => {
  const code = `export default function Card($$renderer) {\n  $$renderer.component(($$renderer) => {\n    $$renderer.push('x');\n  });\n}\n`;

  it('returns development output untouched', () => {
    expect(transformPlaygroundServerOutput({ code, path: 'card.svelte', dev: true })).toBe(code);
  });

  it('passes the component to its own boundary in production', () => {
    expect(transformPlaygroundServerOutput({ code, path: 'card.svelte', dev: false })).toContain(
      '}, Card);',
    );
  });
});
