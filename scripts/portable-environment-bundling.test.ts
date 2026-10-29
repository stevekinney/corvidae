import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Bundles Weft's and Operative Gemini's source together, so it lives at the root, where the self-test's
// cache key covers both packages, rather than in either package or in `@lostgradient/testing`.
test('portable environment resolvers bundle without server modules and work without runtime globals', async () => {
  const directory = await mkdtemp(join(import.meta.dirname, '.browser-environment-'));
  try {
    const entrypoint = join(directory, 'main.ts');
    await Bun.write(
      entrypoint,
      `import { resolveEngineEnvironment } from '../../packages/weft/src/runtime/environment-configuration.ts';
import { readEnvironmentConfiguration } from '../../packages/operative-gemini/src/environment-configuration.ts';
const provider = readEnvironmentConfiguration();
globalThis.environmentProbe = { engine: resolveEngineEnvironment(), provider: { googleApiKey: provider.googleApiKey }, serializedProvider: JSON.stringify(provider) };`,
    );
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      conditions: ['browser'],
      format: 'iife',
      define: { 'import.meta.env': 'undefined' },
      metafile: true,
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.some((path) => path.endsWith('/environmentalist/dist/index.browser.js'))).toBe(
      true,
    );
    expect(
      inputs.some((path) => /index\.node\.js|\/jiti\/|\/dotenv\/|\/lib\/server\//.test(path)),
    ).toBe(false);
    const output = await result.outputs[0]!.text();
    const execute = (globals: object) =>
      JSON.parse(
        runInNewContext(`${output}\nJSON.stringify(globalThis.environmentProbe)`, globals),
      );
    expect(execute({})).toEqual({
      engine: { weftDevWarnings: false },
      provider: {},
      serializedProvider: '{}',
    });
    const node = execute({
      process: { env: { NODE_ENV: 'development', GOOGLE_API_KEY: 'node-key' } },
    });
    expect(node.engine.nodeEnv).toBe('development');
    expect(node.provider.googleApiKey).toBe('node-key');
    expect(node.serializedProvider).not.toContain('node-key');
    const bun = execute({
      Bun: { env: { NODE_ENV: 'production', GOOGLE_API_KEY: 'bun-key' } },
      process: { env: { NODE_ENV: 'development', GOOGLE_API_KEY: 'node-key' } },
    });
    expect(bun.engine.nodeEnv).toBe('production');
    expect(bun.provider.googleApiKey).toBe('bun-key');
    expect(bun.serializedProvider).not.toContain('bun-key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
