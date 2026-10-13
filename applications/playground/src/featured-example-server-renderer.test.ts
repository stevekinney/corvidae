import { describe, expect, test } from 'bun:test';

import {
  normalizeBrowserSerializedHtml,
  removeHydrationMarkers,
  renderFeaturedExample,
  setFeaturedExampleRenderer,
  type RenderedFeaturedExample,
} from './featured-example-server-renderer.ts';

/*
 * Every real render spawns a `bun` process that cold-compiles the example's Svelte graph: about a
 * second each on an idle host, three or more under load. Bun applies its 5-second budget to test
 * bodies and to `beforeAll` hooks alike, so the renders run here, at module scope, which it does
 * not time, and one after another so four concurrent compiles do not add their own load. The tests
 * assert on the settled results. A failed render rejects the whole file rather than one test.
 */
const RENDERED_SCENARIOS = [
  ['banner', 'basic'],
  ['chat', 'with-tool-approval'],
  ['diff-viewer', 'basic'],
  ['markdown-editor', 'basic'],
] as const;
const renderedByScenario = new Map<string, RenderedFeaturedExample>();
for (const [componentName, scenario] of RENDERED_SCENARIOS) {
  renderedByScenario.set(
    `${componentName}/${scenario}`,
    await renderFeaturedExample(componentName, scenario, `overview-mount-${scenario}`),
  );
}

function rendered(componentName: string, scenario: string): RenderedFeaturedExample {
  const result = renderedByScenario.get(`${componentName}/${scenario}`);
  if (result === undefined) throw new Error(`${componentName}/${scenario} was not rendered`);
  return result;
}

describe('featured example server renderer', () => {
  test('removes every Svelte hydration marker form without touching authored comments', () => {
    const html =
      '<!----><!--$--><!--/$--><!--[--><!--[!--><!--[0--><!--[-1--><!--[?{"message":"nope"}--><!--]--><!-- keep -->';

    expect(removeHydrationMarkers(html)).toBe('<!-- keep -->');
  });

  test('normalizes self-closing HTML void elements to browser innerHTML syntax', () => {
    expect(
      normalizeBrowserSerializedHtml(
        '<input type="text"/><br/><img src="preview.png"/><svg><path d="M0 0"/></svg>',
      ),
    ).toBe('<input type="text"><br><img src="preview.png"><svg><path d="M0 0"/></svg>');
  });

  test('emits the generated example import as a normalized relative specifier', async () => {
    const workerSource = await Bun.file(
      new URL('./featured-example-server-worker.ts', import.meta.url),
    ).text();

    expect(workerSource).toContain(
      "relative(dirname(entryPath), examplePath).split(sep).join('/')",
    );
    expect(workerSource).toContain('JSON.stringify(exampleImportSpecifier)');
    expect(workerSource).not.toContain('JSON.stringify(examplePath)');
  });

  test('delegates to a substitute renderer without spawning, and spawns again once it is cleared', async () => {
    const calls: string[] = [];
    setFeaturedExampleRenderer(async (componentName, scenario, mountIdPrefix) => {
      calls.push(`${componentName}/${scenario}:${mountIdPrefix}`);
      return { body: '<p>substitute</p>', head: '' };
    });
    try {
      // No such example exists, so only the substitute can answer without throwing.
      expect(
        await renderFeaturedExample('no-such-component', 'none', 'overview-mount-none'),
      ).toEqual({
        body: '<p>substitute</p>',
        head: '',
      });
      expect(calls).toEqual(['no-such-component/none:overview-mount-none']);
    } finally {
      setFeaturedExampleRenderer(null);
    }
    // The memoized real render answers again; the substitute is no longer consulted.
    expect(await renderFeaturedExample('banner', 'basic', 'overview-mount-basic')).toBe(
      rendered('banner', 'basic'),
    );
    expect(calls).toHaveLength(1);
  });

  test('renders the featured scenario with the same mount prefix used by client hydration', () => {
    const banner = rendered('banner', 'basic');

    expect(banner.body).toContain('cinder-banner');
    expect(banner.body).toContain('Scheduled maintenance is planned');
    expect(banner.body).not.toContain('<!--');
  });
  test('renders approval arguments and pending decisions from the published action contract', () => {
    const chat = rendered('chat', 'with-tool-approval');

    expect(chat.body).toContain('Deploying version 2.4.1 to production');
    expect(chat.body).toContain('Arguments');
    expect(chat.body).toContain('data-cinder-status="pending"');
    expect(chat.body).toContain('Approve');
    expect(chat.body).toContain('Deny');
  });

  // A library component keeps its CSS in a sidecar only when it ships one. Editor components carry
  // scoped `<style>` blocks, and the shared compiler writes that CSS to an external file that the
  // server build never loads, so unless the worker asks for it to be injected the server-rendered
  // overview reaches the browser unstyled until the client bundle mounts (and stays so without
  // JavaScript).
  test.each([
    ['diff-viewer', 'basic'],
    ['markdown-editor', 'basic'],
  ])(
    'injects the scoped styles of the Editor component %s/%s renders into the head',
    (componentName, scenario) => {
      const editor = rendered(componentName, scenario);

      expect(editor.head).toContain('<style');
      // The component's own scoped class names appear in both the markup and the injected rules.
      const scopedClasses = new Set(editor.body.match(/\bsvelte-[a-z0-9]+\b/g) ?? []);
      expect(scopedClasses.size).toBeGreaterThan(0);
      for (const scopedClass of scopedClasses) expect(editor.head).toContain(`.${scopedClass}`);
    },
  );
});
