/**
 * The panel build against the real Cinder panel kit (COR-2216). Each build bundles Svelte, Cinder's
 * stylesheet and a Cinder component, which takes seconds, so these live in the slow lane beside the
 * fast panel build tests in `panel-build.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildTwiceThroughCache,
  CINDER_PANEL_FILES,
  DECOY_CINDER,
  DECOY_FILES,
  DECOY_SVELTE,
  panelBuildFixtures,
} from './panel-build.test-support.ts';

const { fixture, build, cleanup } = panelBuildFixtures();
afterEach(cleanup);

describe('buildPanelPage with a Cinder panel (COR-2216)', () => {
  test('a folder plugin with no node_modules builds into one document, every stylesheet inline, no external reference', async () => {
    const directory = await fixture(CINDER_PANEL_FILES);
    const { html, contentDigest } = await build(directory, 'panel.ts');

    expect(contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(1);
    // The kit's token rule and Cinder's layers are in the one inline stylesheet.
    const inlineStyles = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(inlineStyles).toContain('--cinder-status-info-background');
    expect(inlineStyles).toContain('@layer');
    expect(inlineStyles).toContain('--color-background-primary');
    // Nothing the document loads comes from outside it.
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    // In the stylesheet only: the script holds libraries with a `url(` method of their own.
    expect(inlineStyles).not.toMatch(/@import/);
    expect(inlineStyles).not.toMatch(/url\(\s*['"]?(?!data:)[^)'"\s]/);
    expect(html).not.toMatch(/\b(?:import|from)\s*["'](?:\.{0,2}\/|https?:)/);
  });

  test('the plugin styles come after the kit styles, so a plugin can override them', async () => {
    const directory = await fixture(CINDER_PANEL_FILES);
    const { html } = await build(directory, 'panel.ts', '.fixture-marker{color:red}');
    expect(html.indexOf('.fixture-marker')).toBeGreaterThan(html.indexOf('--cinder-text-default'));
  });

  test('a real Cinder build is stored by the cache once and then served without building (COR-2219)', async () => {
    const directory = await fixture(CINDER_PANEL_FILES);
    const { builds, stored, first, second } = await buildTwiceThroughCache(directory, 'panel.ts');
    expect(stored).toHaveLength(1);
    expect(builds).toBe(1);
    expect(second).toEqual(first);
  });

  test('a plugin that carries its own svelte and Cinder builds with the host copies', async () => {
    const directory = await fixture({ ...CINDER_PANEL_FILES, ...DECOY_FILES });
    const { html } = await build(directory, 'panel.ts');
    expect(html).not.toContain(DECOY_SVELTE);
    expect(html).not.toContain(DECOY_CINDER);
    // The host's Cinder panel kit is what mounted: its token rule is in the document.
    expect(html).toContain('--cinder-status-info-background');
  });
});
