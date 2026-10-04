import { afterEach, describe, expect, it } from 'bun:test';

import { compileSvelteComponentForBun } from '@lostgradient/testing';
import type { BunPlugin, OnLoadResult } from 'bun';

import { CINDER_COMPONENT_SOURCE, EDITOR_COMPONENT_SOURCE } from './component-sources.ts';
import { PLAYGROUND_ROOT } from './playground-paths.ts';
import {
  isPlaygroundPath,
  playgroundSveltePlugin,
  transformPlaygroundServerOutput,
} from './playground-svelte-plugin.ts';

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
