import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { componentMetadataPath, relocatedJsonDocument } from './metadata-files.ts';

const repositoryRoot = resolve(import.meta.dir, '../../../..');

describe('relocatedJsonDocument', () => {
  // The `metadata` task copies each authored `<id>.examples.json` into `.metadata/<id>/`. The
  // authored `$schema` is relative to the component directory, so an unchanged copy points outside
  // the repository; the copy must name the same schema file.
  for (const pkg of ['cinder', 'chat', 'editor']) {
    test(`a copied ${pkg} examples document names a schema file that exists`, () => {
      const packageRoot = join(repositoryRoot, 'components', pkg);
      const authored = [...new Bun.Glob('src/**/*.examples.json').scanSync({ cwd: packageRoot })];
      expect(authored.length).toBeGreaterThan(0);
      const unresolved: string[] = [];
      for (const file of authored) {
        const from = join(packageRoot, file);
        const id = file
          .split('/')
          .at(-1)!
          .replace(/\.examples\.json$/, '');
        const to = componentMetadataPath(packageRoot, id, 'examples');
        const copy = JSON.parse(relocatedJsonDocument(readFileSync(from, 'utf8'), from, to)) as {
          $schema?: string;
        };
        if (copy.$schema === undefined) continue;
        const schemaFile = resolve(dirname(to), copy.$schema);
        if (!existsSync(schemaFile)) unresolved.push(`${file} -> ${copy.$schema}`);
      }
      expect(unresolved).toEqual([]);
    });
  }

  test('keeps every other field and leaves a document with no relative $schema as it was', () => {
    const from = '/repo/components/demo/src/components/demo/demo.examples.json';
    const to = '/repo/components/demo/.metadata/demo/examples.json';
    const relocated = JSON.parse(
      relocatedJsonDocument(
        JSON.stringify({ $schema: '../../schemas/examples.schema.json', component: 'demo' }),
        from,
        to,
      ),
    );
    expect(relocated).toEqual({
      $schema: '../../src/schemas/examples.schema.json',
      component: 'demo',
    });
    const remote = '{"$schema":"https://example.com/schema.json","component":"demo"}';
    expect(relocatedJsonDocument(remote, from, to)).toBe(remote);
    const none = '{"component":"demo"}';
    expect(relocatedJsonDocument(none, from, to)).toBe(none);
  });
});
