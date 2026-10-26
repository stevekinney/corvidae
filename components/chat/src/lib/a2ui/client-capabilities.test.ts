/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import {
  A2UI_SURFACE_CATALOG_ID,
  A2UI_SURFACE_CLIENT_CAPABILITIES,
} from './client-capabilities.ts';
import type { A2uiDiagnostic } from './types.ts';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: A2uiSurface } = await import('./a2ui-surface.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// Cinder's A2UI catalog id (`components/cinder/a2ui-catalog.json`), spelled out because this
// package's tests must not read a sibling workspace's files. Clients list it in
// `supportedCatalogIds`, so Cinder pins it as a one-way door.
const CINDER_CATALOG_ID = 'https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json';

const basicCatalog = (await Bun.file(
  new URL('./basic-catalog.schema.json', import.meta.url),
).json()) as { catalogId: string };

describe('the catalogs A2uiSurface declares', () => {
  test('are exactly the vendored basic catalog', () => {
    expect(A2UI_SURFACE_CATALOG_ID).toBe(basicCatalog.catalogId);
    expect(A2UI_SURFACE_CLIENT_CAPABILITIES).toEqual({
      'v0.9': { supportedCatalogIds: [basicCatalog.catalogId] },
    });
  });

  test('never name Cinder’s catalog, which A2uiSurface cannot render', async () => {
    const declared: readonly string[] =
      A2UI_SURFACE_CLIENT_CAPABILITIES['v0.9'].supportedCatalogIds;
    expect(declared).not.toContain(CINDER_CATALOG_ID);

    const diagnostics: A2uiDiagnostic[] = [];
    const view = render(A2uiSurface, {
      props: {
        surfaceId: 'cinder',
        components: [{ id: 'root', component: 'Meter', value: 3, max: 10 }],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.container.querySelector('[data-a2ui-id="root"]')).toBeNull();
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unsupported-component']);
  });
});
