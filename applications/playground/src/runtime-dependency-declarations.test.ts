import { describe, expect, it } from 'bun:test';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

/**
 * The playground is a private application whose dev server, server renderers, and static
 * exporter import packages at runtime, so each one belongs in `dependencies`: a package the
 * source imports but only `devDependencies` names would be missing from an install that omits
 * development dependencies, and the manifest would misstate what the application needs.
 * Type-only imports are erased and stay free to live in `devDependencies`.
 */
const applicationRoot = join(import.meta.dirname, '..');
const importPattern =
  /(?:^|[\s;{}])(?:import|export)\s+(type\s+)?(?:[^'"()]*?\sfrom\s+)?['"]([^'"./][^'"]*)['"]|import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/gmu;

/** A real package specifier, which rules out prose and template text inside strings and comments. */
const packageSpecifierPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/.*)?$/u;

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

async function runtimeImportedPackages(): Promise<Map<string, string>> {
  const importers = new Map<string, string>();
  const glob = new Bun.Glob('src/**/*.{ts,svelte}');
  for await (const path of glob.scan({ cwd: applicationRoot, onlyFiles: true })) {
    if (/\.test\.|\.test-support\.|-fixture|-probe|-mock/u.test(path)) continue;
    const source = await Bun.file(join(applicationRoot, path)).text();
    for (const match of source.matchAll(importPattern)) {
      if (match[1] !== undefined) continue;
      const specifier = match[2] ?? match[3];
      if (specifier === undefined || !packageSpecifierPattern.test(specifier)) continue;
      if (specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier === 'bun') {
        continue;
      }
      if (builtinModules.includes(specifier)) continue;
      const name = packageNameOf(specifier);
      if (!importers.has(name)) importers.set(name, path);
    }
  }
  return importers;
}

describe('the playground manifest', () => {
  it('declares every package its source imports at runtime under dependencies', async () => {
    const manifest = (await Bun.file(join(applicationRoot, 'package.json')).json()) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const missing = [...(await runtimeImportedPackages())]
      .filter(([name]) => name !== manifest.name && !declared.has(name))
      .map(([name, importer]) => `${name} (first imported by ${importer})`);

    expect(missing).toEqual([]);
  });
});
