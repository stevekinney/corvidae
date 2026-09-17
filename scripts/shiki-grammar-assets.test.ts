import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGrammarData, replaceGrammarData } from './shiki-grammar-assets.ts';

const grammar = { name: 'fixture', scopeName: 'source.fixture', patterns: [{ match: 'word' }] };
const json = JSON.stringify(grammar);
const source = `const lang = Object.freeze(JSON.parse(${JSON.stringify(json)})); export default [lang];`;

async function evaluateModule(code: string): Promise<{ default: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-grammar-'));
  try {
    const path = join(directory, 'grammar.ts');
    await Bun.write(path, code);
    return await import(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Shiki grammar assets', () => {
  test('extracts the exact JSON payload and keeps the surrounding module intact', () => {
    const data = readGrammarData(source, 'fixture.mjs');
    expect(data?.json).toBe(json);
    expect(data).toBeDefined();
    if (!data) throw new Error('Expected grammar data');
    const transformed = replaceGrammarData(source, data, JSON.stringify('fixture.json'));
    expect(transformed).toStartWith('const lang = Object.freeze(');
    expect(transformed).toEndWith('); export default [lang];');
    expect(transformed).not.toContain('JSON.parse(');
  });

  test('preserves nested grammar imports', () => {
    const withImports = `import nested from './nested.mjs';\n${source}`;
    const data = readGrammarData(withImports, 'fixture.mjs');
    if (!data) throw new Error('Expected grammar data');
    expect(replaceGrammarData(withImports, data, 'assetUrl')).toStartWith(
      "import nested from './nested.mjs';",
    );
  });

  test('leaves registry modules and unrelated JSON parsing alone', () => {
    expect(readGrammarData('export const languages = {};', 'index.mjs')).toBeUndefined();
    expect(readGrammarData('const options = JSON.parse("{}");', 'options.mjs')).toBeUndefined();
  });

  test('loads the same frozen grammar through the platform fetch API', async () => {
    const data = readGrammarData(source, 'fixture.mjs');
    if (!data) throw new Error('Expected grammar data');
    const url = `data:application/json,${encodeURIComponent(json)}`;
    const transformed = replaceGrammarData(source, data, JSON.stringify(url));
    const module = await evaluateModule(transformed);
    expect(module.default).toEqual([grammar]);
    expect(Array.isArray(module.default) && Object.isFrozen(module.default[0])).toBe(true);
  });

  test('rejects a failed grammar response rather than parsing an error document', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('missing', { status: 404 }) });
    try {
      const data = readGrammarData(source, 'fixture.mjs');
      if (!data) throw new Error('Expected grammar data');
      const transformed = replaceGrammarData(source, data, JSON.stringify(server.url.href));
      let caught: unknown;
      try {
        await evaluateModule(transformed);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof Error && caught.message).toContain('404');
    } finally {
      server.stop(true);
    }
  });
});
