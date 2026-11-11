import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundleBrowserScript } from './bundle-build.ts';
import { editorRoot } from './paths.ts';

// A small editor component with a `<style>` block, which the bundle injects at runtime.
const styledComponent = join(
  editorRoot,
  'src/lib/components/markdown-editor/editor-toolbar/toolbar-separator.svelte',
);

const directory = createTemporaryDirectory('cinder-design-system-bundle-build');

afterAll(() => removeTemporaryPath(directory));

async function bundle(name: string, source: string): Promise<string> {
  const entry = join(directory, `${name}.ts`);
  writeFileSync(entry, source);
  const script = await bundleBrowserScript(entry);
  if (script instanceof Error) throw script;
  return script;
}

describe('bundleBrowserScript', () => {
  test('compiles Svelte for production, so injected styles carry no embedded source map', async () => {
    // Under `bun test` NODE_ENV is "test"; a development compile appended a base64 source map,
    // the component's whole source, to every injected stylesheet.
    const script = await bundle(
      'styled',
      `import Separator from ${JSON.stringify(styledComponent)};\nwindow.Separator = Separator;\n`,
    );
    expect(script).toContain('.toolbar-separator');
    expect(script).not.toContain('sourceMappingURL');
    expect(script).not.toContain(styledComponent);
  });

  test('gives import.meta.url a value, since a classic script cannot say import.meta', async () => {
    const script = await bundle('meta', 'window.address = import.meta.url;\n');
    expect(script).not.toContain('import.meta');
    expect(script).toContain('about:blank');
  });
});
