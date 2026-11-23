import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('the client entry on the browser target', () => {
  it('bundles the complete client entry without Bun or Node imports', async () => {
    const text = await bundle('./index.ts');
    expect(text).not.toMatch(/\bfrom\s*["'](?:bun|node:[^"']*)["']/u);
    expect(text).not.toMatch(/\brequire\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);
    expect(text).not.toMatch(/\bimport\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);
  });

  it('keeps registry code and Zod out of a remote-only client bundle', async () => {
    const text = await bundle('./__fixtures__/remote-client-entry.ts');
    const modules = [...text.matchAll(/^\/\/ (\S+\.ts)$/gmu)].map((match) => match[1]!);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((module) => !module.includes('client/'))).toEqual([]);
    expect(text).not.toContain('zod');
  });

  it('builds the generated Fetch and injected bridge entries without server dependencies', async () => {
    for (const entry of [
      './__fixtures__/generated-fetch-page.ts',
      './__fixtures__/generated-bridge.ts',
    ]) {
      const text = await bundle(entry);
      const modules = [...text.matchAll(/^\/\/ (\S+\.ts)$/gmu)].map((match) => match[1]!);
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.join('\n')).not.toMatch(
        /(?:node:|bun:|armorer|velveteen|svelte|credentials|modelcontextprotocol|bureau-transport)/iu,
      );
    }
  });
});

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
    target: 'browser',
    external: [],
  });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(result.outputs.length).toBeGreaterThan(0);

  return result.outputs[0]!.text();
}
