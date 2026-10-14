import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PLAYGROUND_IMPORT_OPTIMIZATION, SHARED_BUILD_OPTIONS } from './build-artifacts-shared.ts';
import { curatedCodeHighlighter } from './curated-shiki-adapter.ts';
import { PLAYGROUND_TEMP_ROOT } from './playground-paths.ts';

const curatedAdapterSource = await Bun.file(
  new URL('./curated-shiki-adapter.ts', import.meta.url),
).text();

describe('the playground publishes a curated Shiki highlighter', () => {
  it('keeps the full registry out of the curated module', () => {
    // The whole point: neither barrel may appear here. `shiki/langs` alone is
    // 253 grammars, ~9.8 MB of source, walked once per page bundle.
    expect(curatedAdapterSource).not.toMatch(/from '(shiki\/langs|shiki\/themes)'/);
    expect(curatedAdapterSource).not.toMatch(/import\('(shiki\/langs|shiki\/themes)'\)/);
    expect(curatedAdapterSource).not.toContain('fullShikiHighlighter(');
  });

  it('names the two themes the adapter applies by default', () => {
    // Narrowing the theme registry is only safe while it covers the pair the
    // adapter resolves by name when no `theme` option is given.
    expect(curatedAdapterSource).toContain("'github-light'");
    expect(curatedAdapterSource).toContain("'github-dark'");
  });

  it('highlights a curated language with the default theme pair', async () => {
    const html = await curatedCodeHighlighter('SELECT 1;', 'sql');
    expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
    expect(html).toContain('--shiki-dark');
  });
});

describe('playground builds walk only the Cinder exports a page imports', () => {
  it('shares one import optimization across the client and server builds', () => {
    expect(PLAYGROUND_IMPORT_OPTIMIZATION).toEqual(['@lostgradient/cinder']);
    expect(SHARED_BUILD_OPTIONS.optimizeImports).toBe(PLAYGROUND_IMPORT_OPTIMIZATION);
  });

  it('resolves no Shiki grammar for a page that imports Cinder without its full registry', async () => {
    // Cinder's root re-exports `fullShikiHighlighter`, whose module reaches
    // every grammar through `shiki/langs`. Tree-shaking keeps those grammars
    // out of the output either way; what costs memory is the bundler walking
    // them. Count every grammar import the build resolves.
    await mkdir(PLAYGROUND_TEMP_ROOT, { recursive: true });
    const directory = await mkdtemp(join(PLAYGROUND_TEMP_ROOT, 'curated-shiki-walk-'));
    try {
      const entry = join(directory, 'page.ts');
      await writeFile(
        entry,
        "import { Button, CodeBlock } from '@lostgradient/cinder';\nconsole.log(Button, CodeBlock);\n",
      );
      const resolvedGrammarImports: string[] = [];
      const result = await Bun.build({
        ...SHARED_BUILD_OPTIONS,
        entrypoints: [entry],
        publicPath: '/page-bundle/',
        plugins: [
          ...SHARED_BUILD_OPTIONS.plugins,
          {
            name: 'count-grammar-imports',
            setup(build) {
              build.onResolve({ filter: /^(?:shiki\/langs|@shikijs\/langs\/)/ }, (argument) => {
                resolvedGrammarImports.push(argument.path);
                return undefined;
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(resolvedGrammarImports).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
