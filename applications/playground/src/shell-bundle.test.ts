/**
 * The shared shell ships neither the Cinder root barrel nor Shiki's full grammar registry
 * (CIN-588 preservation contract). The criterion was first written against parsed inputs; the
 * shell imports from `@lostgradient/cinder`, whose root is its only export, so the barrel is always
 * parsed and then tree-shaken. The intent is that it does not ship, so these assertions read the
 * bytes each input contributes to the output, not whether it was parsed.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

import { PUBLIC_PATH_BY_FAMILY, SHARED_BUILD_OPTIONS } from './build-artifacts-shared.ts';
import { PLAYGROUND_ROOT } from './playground-paths.ts';

type Metafile = {
  inputs: Record<string, { imports: { path: string; kind: string; original?: string }[] }>;
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
};

const CINDER_ROOT = '@lostgradient/cinder';
/** The curated highlighter the playground publishes beneath every component it mounts. */
const CURATED_SHIKI_ADAPTER_PATH = join(PLAYGROUND_ROOT, 'src', 'curated-shiki-adapter.ts');
const BARREL_SUFFIX = 'components/cinder/src/index.ts';
const GRAMMAR = /@shikijs[\\/]langs[\\/]dist[\\/]([^\\/]+)$/u;

async function metafileOf(entrypoint: string, publicPath: string): Promise<Metafile> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    publicPath,
    ...SHARED_BUILD_OPTIONS,
    metafile: true,
  });
  if (!result.success || result.metafile === undefined) {
    throw new Error(
      `Building ${entrypoint} failed: ${result.logs.map((log) => log.message).join('\n')}`,
    );
  }
  return result.metafile;
}

/** Every input path that contributes at least one byte to any output. */
function shippedInputs(metafile: Metafile): Map<string, number> {
  const shipped = new Map<string, number>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
      shipped.set(path, (shipped.get(path) ?? 0) + bytesInOutput);
    }
  }
  return shipped;
}

/** The names a source file imports at runtime from the Cinder root (type-only imports excluded). */
export function namedCinderImports(source: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@lostgradient\/cinder['"]/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    for (const part of match[2]!.split(',')) {
      const binding = part.trim();
      if (binding === '' || binding.startsWith('type ')) continue;
      names.push(binding.split(/\s+as\s+/u)[0]!.trim());
    }
  }
  return names;
}

/** The module each runtime name a file re-exports by name comes from, relative to that file. */
export function barrelModules(barrelSource: string): Map<string, string> {
  const modules = new Map<string, string>();
  const pattern = /export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of barrelSource.matchAll(pattern)) {
    for (const part of match[1]!.split(',')) {
      const binding = part.trim();
      if (binding === '' || binding.startsWith('type ')) continue;
      const exported = binding
        .split(/\s+as\s+/u)
        .at(-1)!
        .trim();
      modules.set(exported, match[2]!);
    }
  }
  return modules;
}

/** Whether a module declares `name` as one of its own runtime exports. */
function declaresExport(source: string, name: string): boolean {
  const declaration = new RegExp(
    String.raw`export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+${name}\b`,
    'u',
  );
  if (declaration.test(source)) return true;
  for (const match of source.matchAll(/export\s+\{([^}]*)\}(?!\s*from)/gu)) {
    const names = match[1]!.split(',').map((part) =>
      part
        .trim()
        .split(/\s+as\s+/u)
        .at(-1)!
        .trim(),
    );
    if (names.includes(name)) return true;
  }
  return false;
}

/**
 * The module `name` resolves to through `file`'s exports: a named re-export, the file's own
 * declaration, or (recursively) one of its `export *` targets. Absolute path, or undefined.
 */
export function resolveExport(
  file: string,
  name: string,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const named = barrelModules(source).get(name);
  if (named !== undefined) return normalize(join(dirname(file), named));
  if (declaresExport(source, name)) return file;
  for (const match of source.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/gu)) {
    const found = resolveExport(normalize(join(dirname(file), match[1]!)), name, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every input reachable from `starts` through the metafile's import graph, never via the barrel. */
function reachable(metafile: Metafile, starts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path) || path.endsWith(BARREL_SUFFIX)) continue;
    seen.add(path);
    for (const edge of metafile.inputs[path]?.imports ?? []) pending.push(edge.path);
  }
  return seen;
}

describe('the shared shell bundle (CIN-588 preservation)', () => {
  // One shell build and one adapter build with metafiles are the cost being measured, as in the
  // page-bundle build tests.
  it('ships no byte of the Cinder root barrel, only the components the shell imports, and only curated grammars', async () => {
    const shell = await metafileOf(
      join(PLAYGROUND_ROOT, 'src', 'shell-app', 'shell-entry.ts'),
      PUBLIC_PATH_BY_FAMILY.shell,
    );
    const shipped = shippedInputs(shell);

    // The root barrel is parsed (the shell imports from the package root) but ships nothing.
    const barrelPath = Object.keys(shell.inputs).find((path) => path.endsWith(BARREL_SUFFIX));
    expect(barrelPath).toBeDefined();
    expect(shipped.get(barrelPath!) ?? 0).toBe(0);

    // The shell's direct imports: the runtime names each importer of the root takes from it,
    // mapped through the barrel's own re-exports, then closed over the metafile's import graph.
    const barrelFile = join(PLAYGROUND_ROOT, barrelPath!);
    const starts: string[] = [];
    for (const [path, input] of Object.entries(shell.inputs)) {
      if (path.endsWith(BARREL_SUFFIX) || path.includes('components/cinder/src/')) continue;
      if (!input.imports.some((edge) => edge.original === CINDER_ROOT)) continue;
      for (const name of namedCinderImports(readFileSync(join(PLAYGROUND_ROOT, path), 'utf8'))) {
        const module = resolveExport(barrelFile, name);
        expect(module, `${path} imports ${name}, which the barrel does not export`).toBeDefined();
        starts.push(relative(PLAYGROUND_ROOT, module!));
      }
    }
    expect(starts.length).toBeGreaterThan(0);
    const allowed = reachable(shell, starts);
    const shippedComponents = [...shipped]
      .filter(
        ([path, bytes]) =>
          bytes > 0 && path.includes('components/cinder/src/components/') && !path.endsWith('.css'),
      )
      .map(([path]) => path);
    expect(shippedComponents.length).toBeGreaterThan(0);
    expect(shippedComponents.filter((path) => !allowed.has(path))).toEqual([]);

    // Every grammar the shell reads is one the curated adapter itself allows.
    const curated = await metafileOf(CURATED_SHIKI_ADAPTER_PATH, '/');
    const grammarsOf = (metafile: Metafile): Set<string> =>
      new Set(
        Object.keys(metafile.inputs).flatMap((path) => {
          const match = GRAMMAR.exec(path);
          return match === null ? [] : [match[1]!];
        }),
      );
    const curatedGrammars = grammarsOf(curated);
    expect(curatedGrammars.size).toBeGreaterThan(0);
    expect([...grammarsOf(shell)].filter((grammar) => !curatedGrammars.has(grammar))).toEqual([]);
  });
});

describe('namedCinderImports and barrelModules', () => {
  it('reads runtime named imports from the Cinder root and skips type-only ones', () => {
    expect(
      namedCinderImports(
        "import { Button, type ButtonProps, Input as Field } from '@lostgradient/cinder';\nimport type { Theme } from '@lostgradient/cinder';",
      ),
    ).toEqual(['Button', 'Input']);
  });

  it('maps each re-exported runtime name to its module', () => {
    const modules = barrelModules(
      "export { default as Button } from './components/button/index.ts';\nexport type { ButtonProps } from './components/button/index.ts';\nexport { focusFirst, trap as trapFocus } from './utilities/focus.ts';",
    );
    expect(Object.fromEntries(modules)).toEqual({
      Button: './components/button/index.ts',
      focusFirst: './utilities/focus.ts',
      trapFocus: './utilities/focus.ts',
    });
  });
});
