import { afterEach, describe, expect, it } from 'bun:test';

import { clearPageArtifacts, pageArtifactByPath } from './build-artifacts-shared.ts';
import {
  bareComponentShimSource,
  buildPageBundle,
  compilePageBundleArtifacts,
  pageEntryByName,
  pageEntryComponent,
  prebuildPageBundlesInBatches,
} from './page-bundle.ts';
import { incrementRebuildGeneration } from './rebuild-generation.ts';

const MEBIBYTE = 1024 * 1024;

describe('bareComponentShimSource', () => {
  it('re-exports only the documented component from the package root', () => {
    expect(bareComponentShimSource('@lostgradient/cinder', 'Button')).toBe(
      'export { Button } from "@lostgradient/cinder";\n',
    );
  });

  it('quotes the import path as a JSON string so no specifier can break out of it', () => {
    expect(bareComponentShimSource('@lostgradient/chat"; throw 1; "', 'Chat')).toBe(
      'export { Chat } from "@lostgradient/chat\\"; throw 1; \\"";\n',
    );
  });
});

describe('compilePageBundleArtifacts', () => {
  // A bundle builds from the real package root, so a cold Bun.build over the
  // Cinder barrel is the cost being measured. The budget is for that build, not
  // for a slow assertion.
  it('keeps every artifact small by loading only the documented component', async () => {
    const entry = await compilePageBundleArtifacts('button');

    expect(entry).not.toBeNull();
    const artifactSizes = [...entry!.artifacts].map(([path, code]) => ({
      path,
      bytes: Buffer.byteLength(code),
    }));
    // A dynamic `import('@lostgradient/cinder')` keeps every export of the
    // package root, which emitted a 5.7 MiB chunk for Button. Importing only the
    // documented component through a per-page module keeps each artifact well
    // under this bound.
    const oversized = artifactSizes.filter(({ bytes }) => bytes > 2 * MEBIBYTE);
    expect(oversized).toEqual([]);
  }, 60_000);
});

describe('pageEntryComponent', () => {
  const names = new Set(['code-block', 'code', 'button']);

  it('maps an emitted entry to its component, hyphenated names included', () => {
    expect(pageEntryComponent('page-code-block-a1b2c3d4.js', names)).toBe('code-block');
    expect(pageEntryComponent('page-code-a1b2c3d4.js', names)).toBe('code');
  });

  it('ignores chunks and entries for components outside the batch', () => {
    expect(pageEntryComponent('chunk-a1b2c3d4.js', names)).toBeUndefined();
    expect(pageEntryComponent('page-modal-a1b2c3d4.js', names)).toBeUndefined();
  });
});

describe('prebuildPageBundlesInBatches', () => {
  afterEach(() => {
    pageEntryByName.clear();
    clearPageArtifacts();
  });

  it('refuses a batch size that is not a positive integer', async () => {
    let message = '';
    try {
      await prebuildPageBundlesInBatches(['button'], undefined, 0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('batchSize must be a positive integer');
  });

  // Two shared builds (a batch of two pages, then one) are the cost being measured, as in the
  // single-page test above.
  it('builds pages in shared batches, collects garbage between batches, and publishes each page', async () => {
    let collections = 0;
    const results = await prebuildPageBundlesInBatches(
      ['button', 'badge', 'kbd', 'not-a-component'],
      undefined,
      2,
      () => {
        collections += 1;
      },
    );

    expect(collections).toBe(1);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const values = results.map((result) =>
      result.status === 'fulfilled' ? result.value : 'rejected',
    );
    expect(values[3]).toBeNull();
    for (const name of ['button', 'badge', 'kbd']) {
      const entryPath = pageEntryByName.get(name);
      expect(entryPath).toMatch(new RegExp(`^page-${name}-[A-Za-z0-9]+\\.js$`));
      expect(pageArtifactByPath.has(entryPath!)).toBe(true);
    }
    expect(pageEntryByName.has('not-a-component')).toBe(false);
  }, 60_000);

  it('never publishes an entry pointer for a batch an invalidation superseded', async () => {
    const prebuild = prebuildPageBundlesInBatches(['button']);
    // The batch captured its generation synchronously; this invalidation supersedes it.
    incrementRebuildGeneration();
    const [result] = await prebuild;

    expect(result?.status).toBe('fulfilled');
    expect(pageEntryByName.has('button')).toBe(false);
  }, 60_000);
});

describe('buildPageBundle generation', () => {
  afterEach(() => {
    pageEntryByName.clear();
    clearPageArtifacts();
  });

  it('never publishes an entry pointer for a lazy build an invalidation superseded', async () => {
    const build = buildPageBundle('button');
    incrementRebuildGeneration();
    const stableEntry = await build;

    expect(stableEntry).toMatch(/^import "\/page-bundle\/page-button-[A-Za-z0-9]+\.js";\n$/);
    expect(pageEntryByName.has('button')).toBe(false);
  }, 60_000);
});
