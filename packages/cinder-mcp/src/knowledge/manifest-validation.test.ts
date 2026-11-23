import { expect, test } from 'bun:test';
import { validateManifest } from './manifest-validation.js';
import type { CinderManifest } from './types.js';

const manifest = {
  manifestVersion: 1,
  package: {
    name: '@lostgradient/cinder',
    framework: 'svelte',
    frameworkVersionRange: '^5.0.0',
    stylesEntry: '@lostgradient/cinder',
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  },
  categories: {},
  statusLevels: {},
  overlapFamilies: {},
  components: [],
} satisfies CinderManifest;

test('accepts Cinder manifest version one', () => {
  expect(validateManifest(manifest)).toEqual(manifest);
});

test('rejects unsupported manifest versions before the server registers tools', () => {
  expect(() => validateManifest({ ...manifest, manifestVersion: 2 })).toThrow('manifestVersion 1');
});
