import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('the package entries on the browser target', () => {
  for (const entry of ['index.ts', 'internals.ts']) {
    it(`bundles ${entry} with no error and no Bun or Node import`, async () => {
      const result = await Bun.build({
        entrypoints: [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
        target: 'browser',
        external: [],
      });
      expect(result.success).toBe(true);
      expect(result.logs).toEqual([]);
      expect(result.outputs.length).toBeGreaterThan(0);

      const text = await result.outputs[0]!.text();
      // The bundle inlines Zod. It must not import a runtime module of its own.
      expect(text).not.toMatch(/\bfrom\s*["'](?:bun|node:[^"']*)["']/u);
      expect(text).not.toMatch(/\brequire\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);
      expect(text).not.toMatch(/\bimport\(\s*["'](?:bun|node:[^"']*)["']\s*\)/u);
    });
  }
});
