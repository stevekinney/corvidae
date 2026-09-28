import { expect, test } from 'bun:test';
import { normalizePublishedManifest, verifyRegistryManifest } from './registry-manifest.ts';

test('normalizes workspace and catalog ranges without erasing conditional export order', () => {
  const manifest = {
    name: 'consumer',
    version: '1.0.0',
    dependencies: { sibling: 'workspace:^', external: 'catalog:' },
    exports: { '.': { default: './fallback.js', browser: './browser.js' } },
  };
  const normalized = normalizePublishedManifest(
    manifest,
    { catalog: { external: '^2.0.0' } },
    new Map([['sibling', '3.0.0']]),
  );
  expect(normalized['dependencies']).toEqual({ sibling: '^3.0.0', external: '^2.0.0' });
  expect(Object.keys((normalized['exports'] as Record<string, object>)['.']!)).toEqual([
    'default',
    'browser',
  ]);
});

test('rejects registry contract differences even when the source digest matches', () => {
  const target = {
    name: 'consumer',
    version: '1.0.0',
    files: ['dist'],
    exports: { '.': { browser: './browser.js', default: './index.js' } },
  };
  expect(() => verifyRegistryManifest({ ...target, files: ['src'] }, target)).toThrow(
    'registry manifest differs',
  );
  expect(() =>
    verifyRegistryManifest(
      { ...target, exports: { '.': { default: './index.js', browser: './browser.js' } } },
      target,
    ),
  ).toThrow('registry manifest differs');
  expect(verifyRegistryManifest(target, target).digest).toMatch(/^[a-f0-9]{64}$/);
});
