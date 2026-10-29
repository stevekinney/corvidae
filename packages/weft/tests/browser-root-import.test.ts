import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('package root platform boundaries', () => {
  it('bundles the complete public API for the browser without external native modules', async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      target: 'browser',
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(result.outputs.length).toBeGreaterThan(0);
  });

  it('exposes source storage and workflow APIs through the root', async () => {
    const api = await import('../src/index.ts');
    for (const name of ['Engine', 'BunSQLiteStorage', 'resolveStorage', 'HttpClient']) {
      expect(Reflect.get(api, name), name).toBeFunction();
    }
  });

  it('leaves the storage protocol to @lostgradient/storage', async () => {
    const api = await import('../src/index.ts');
    for (const name of ['MemoryStorage', 'ScopedStorage', 'textValueStore', 'storageBatch']) {
      expect(Reflect.has(api, name), name).toBe(false);
    }
  });
});
