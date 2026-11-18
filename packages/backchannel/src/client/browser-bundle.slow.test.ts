import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('the client entry on the browser target', () => {
  it('bundles with no error, no Bun or Node import, and no handler or registry module', async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
      target: 'browser',
      external: [],
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(result.outputs.length).toBeGreaterThan(0);

    const text = await result.outputs[0]!.text();
    expect(text).not.toMatch(/\bfrom\s*["'](?:bun|node:[^"']*)["']/u);
    expect(text).not.toMatch(/\brequire\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);
    expect(text).not.toMatch(/\bimport\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);

    // The bundle names every module it inlines in a `// path` comment. The client entry reaches
    // the browser alone: none of the server's modules, and not Zod, which the handler needs.
    const modules = [...text.matchAll(/^\/\/ (\S+\.ts)$/gmu)].map((match) => match[1]!);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((module) => /(?:^|\/)handler\//u.test(module))).toEqual([]);
    expect(modules.filter((module) => /registry|operation-catalog/u.test(module))).toEqual([]);
    expect(modules.filter((module) => !module.includes('client/'))).toEqual([]);
    expect(text).not.toContain('zod');
  });
});
