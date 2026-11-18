/**
 * The metadata half of the package's export surface (COR-2078). The `metadata` task writes each
 * component's schema, variables and examples to `.metadata/`, and the package exports them as
 * `./<component>/schema`, `./<component>/variables` and `./<component>/examples`, with the manifest
 * at `./manifest`. The root barrel exports components and their API, and no metadata.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { describe, expect, test } from 'bun:test';

const PACKAGE = '@lostgradient/cinder';

type Manifest = { components: Array<{ id: string; hasExamples: boolean }> };

function resolve(subpath: string): string {
  return Bun.resolveSync(`${PACKAGE}/${subpath}`, import.meta.dir);
}

const manifest = JSON.parse(readFileSync(resolve('manifest'), 'utf8')) as Manifest;

/**
 * Every module the root barrel re-exports from, followed through relative `export … from`
 * statements. Read as text rather than imported: importing the barrel evaluates every component.
 */
function reExportedModules(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.ts')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(
      /^export\s[^;]*?from\s+'(\.[^']+)'/gm,
    )) {
      const base = resolvePath(dirname(file), match[1] ?? '');
      const target = [base, `${base}.ts`, join(base, 'index.ts')].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (target !== undefined) pending.push(target);
    }
  }
  return [...seen];
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

  test('the root barrel re-exports no metadata module', () => {
    const modules = reExportedModules(join(import.meta.dir, 'index.ts'));
    expect(modules.length).toBeGreaterThan(1);
    expect(
      modules.filter((file) =>
        /\.(?:schema|variables)\.ts$|\/\.metadata\/|(?:components|examples|constraints|schema|variables)\.json$|\/exports\/metadata-[^/]+\.ts$/.test(
          file,
        ),
      ),
    ).toEqual([]);
  });
});
