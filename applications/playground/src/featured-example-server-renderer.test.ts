import { describe, expect, test } from 'bun:test';

import {
  normalizeBrowserSerializedHtml,
  removeHydrationMarkers,
  renderFeaturedExample,
} from './featured-example-server-renderer.ts';

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

  test('renders the featured scenario with the same mount prefix used by client hydration', async () => {
    const rendered = await renderFeaturedExample('banner', 'basic', 'overview-mount-basic');

    expect(rendered.body).toContain('cinder-banner');
    expect(rendered.body).toContain('Scheduled maintenance is planned');
    expect(rendered.body).not.toContain('<!--');
  });
  test('renders approval arguments and pending decisions from the published action contract', async () => {
    const rendered = await renderFeaturedExample(
      'chat',
      'with-tool-approval',
      'overview-mount-with-tool-approval',
    );

    expect(rendered.body).toContain('Deploying version 2.4.1 to production');
    expect(rendered.body).toContain('Arguments');
    expect(rendered.body).toContain('data-cinder-status="pending"');
    expect(rendered.body).toContain('Approve');
    expect(rendered.body).toContain('Deny');
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
    async (componentName, scenario) => {
      const rendered = await renderFeaturedExample(
        componentName,
        scenario,
        `overview-mount-${scenario}`,
      );

      expect(rendered.head).toContain('<style');
      // The component's own scoped class names appear in both the markup and the injected rules.
      const scopedClasses = new Set(rendered.body.match(/\bsvelte-[a-z0-9]+\b/g) ?? []);
      expect(scopedClasses.size).toBeGreaterThan(0);
      for (const scopedClass of scopedClasses) expect(rendered.head).toContain(`.${scopedClass}`);
    },
  );
});
