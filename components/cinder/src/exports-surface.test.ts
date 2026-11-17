/**
 * The metadata half of the package's export surface (COR-2078). The `metadata` task writes each
 * component's schema, variables and examples to `.metadata/`, and the package exports them as
 * `./<component>/schema`, `./<component>/variables` and `./<component>/examples`, with the manifest
 * at `./manifest`. The root barrel exports components and their API, and no metadata.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

const PACKAGE = '@lostgradient/cinder';

type Manifest = { components: Array<{ id: string; hasExamples: boolean }> };

function resolve(subpath: string): string {
  return Bun.resolveSync(`${PACKAGE}/${subpath}`, import.meta.dir);
}

const manifest = JSON.parse(readFileSync(resolve('manifest'), 'utf8')) as Manifest;

function camelCase(id: string): string {
  return id.replaceAll(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

describe(`${PACKAGE} metadata exports`, () => {
  test('./manifest resolves to the generated manifest, which lists components', () => {
    expect(manifest.components.length).toBeGreaterThan(0);
  });

  test('every component exports its schema and variables, and its examples when it has them', () => {
    const missing: string[] = [];
    for (const { id, hasExamples } of manifest.components) {
      for (const kind of ['schema', 'variables', ...(hasExamples ? ['examples'] : [])]) {
        const path = resolve(`${id}/${kind}`);
        if (!existsSync(path)) missing.push(`${id}/${kind} -> ${path}`);
        else JSON.parse(readFileSync(path, 'utf8'));
      }
    }
    expect(missing).toEqual([]);
  });

  test('the root barrel exports no metadata', async () => {
    const root: Record<string, unknown> = await import('./index.ts');
    const metadataNames = new Set(['manifest']);
    for (const { id } of manifest.components) {
      for (const suffix of ['Schema', 'Variables', 'Examples', 'Constraints']) {
        metadataNames.add(`${camelCase(id)}${suffix}`);
      }
    }
    expect(Object.keys(root).filter((name) => metadataNames.has(name))).toEqual([]);
  });
});
