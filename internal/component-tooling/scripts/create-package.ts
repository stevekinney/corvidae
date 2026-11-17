/**
 * Scaffolds a component family package (COR-2079).
 *
 * ```sh
 * bun internal/component-tooling/scripts/create-package.ts <name>                 # components/<name>
 * bun internal/component-tooling/scripts/create-package.ts <name> --root <dir>    # another repository root
 * ```
 *
 * It writes `components/<name>/package.json` (`@lostgradient/<name>`, with the declaration
 * `types` script, the `types`/`svelte`/`default` export conditions, and the `./styles` and
 * `./*.css` stylesheet exports), a two-line `tsconfig.json` extending
 * `@lostgradient/typescript/component.json`, a `bunfig.toml` that preloads the shared test
 * preload, and a `src/index.ts`, `src/styles/index.css`, `src/index.test.ts` and a first
 * `src/components/<name>/<name>.svelte` so the package's lint, type-check and test pass the moment
 * it exists. It never overwrites a file.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TOOLING_SCRIPTS = '../../internal/component-tooling/scripts';

export function packageManifest(name: string): Record<string, unknown> {
  return {
    name: `@lostgradient/${name}`,
    private: true,
    type: 'module',
    exports: {
      '.': {
        types: './.types/src/index.d.ts',
        svelte: './src/index.ts',
        default: './src/index.ts',
      },
      './styles': './src/styles/index.css',
      './*.css': './src/*.css',
    },
    scripts: {
      types: `bun ${TOOLING_SCRIPTS}/emit-declarations.ts`,
      lint: `oxlint --deny-warnings --type-aware --tsconfig ./tsconfig.json src && bun ../../scripts/check-inherited-key-reads.ts && bun ${TOOLING_SCRIPTS}/check-prop-conventions.ts src/components`,
      typecheck: 'svelte-check --workspace . --tsconfig ./tsconfig.json --fail-on-warnings',
      // Four isolated workers, as core runs its tests and the scaffold's bunfig.toml says: the
      // scroll-settling tests (Carousel's) fail when files share one process.
      test: "TZ=UTC LANG=en_US.UTF-8 bun ../../scripts/bun-test-junit.ts --conditions browser --conditions svelte --parallel=4 --path-ignore-patterns='**/*.slow.test.ts' --path-ignore-patterns='**/*.integration.test.ts' src",
      'test:slow':
        'TZ=UTC LANG=en_US.UTF-8 bun ../../scripts/bun-test-selected.ts --conditions browser --conditions svelte .slow.test.ts .integration.test.ts',
      'lint:fix': 'oxlint --deny-warnings --fix --type-aware --tsconfig ./tsconfig.json src',
    },
    dependencies: {
      svelte: 'catalog:',
    },
    devDependencies: {
      '@lostgradient/component-tooling': 'workspace:*',
      '@lostgradient/testing': 'workspace:*',
      '@lostgradient/typescript': 'workspace:*',
      '@types/bun': 'catalog:',
      oxlint: 'catalog:',
      'oxlint-tsgolint': 'catalog:',
      'svelte-check': 'catalog:',
      typescript: 'catalog:',
    },
    sideEffects: ['**/*.css'],
  };
}

/** The files a new family package starts with, by path from its directory. */
export function packageFiles(name: string): Record<string, string> {
  return {
    'package.json': `${JSON.stringify(packageManifest(name), null, 2)}\n`,
    'tsconfig.json': '{\n  "extends": "@lostgradient/typescript/component.json"\n}\n',
    'bunfig.toml': `[run]\nbun = true\n\n[test]\npreload = ["${TOOLING_SCRIPTS}/preload.ts"]\n`,
    'src/index.ts': `/** The public surface of \`@lostgradient/${name}\`. */\nexport const packageName = '@lostgradient/${name}';\n`,
    'src/styles/index.css': `/* The stylesheet of \`@lostgradient/${name}\`. */\n`,
    // A first component, so the Svelte check and the prop conventions have something to read;
    // the family's real components replace it.
    [`src/components/${name}/${name}.svelte`]: `<script lang="ts">\n  import type { Snippet } from 'svelte';\n\n  let { children }: { children?: Snippet } = $props();\n</script>\n\n<div class="cinder-${name}">{@render children?.()}</div>\n`,
    'src/index.test.ts': `import { expect, test } from 'bun:test';\n\nimport { packageName } from './index.ts';\n\ntest('names its package', () => {\n  expect(packageName).toBe('@lostgradient/${name}');\n});\n`,
  };
}

/** Writes the package under `<root>/components/<name>`; returns the paths it wrote. */
export function createPackage(root: string, name: string): string[] {
  if (!KEBAB_CASE.test(name)) {
    throw new Error(`create-package: "${name}" is not a kebab-case package name.`);
  }
  const directory = join(root, 'components', name);
  const files = Object.entries(packageFiles(name));
  const existing = files.filter(([path]) => existsSync(join(directory, path)));
  if (existing.length > 0) {
    throw new Error(
      `create-package: ${existing.map(([path]) => join('components', name, path)).join(', ')} already exist.`,
    );
  }
  for (const [path, content] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return files.map(([path]) => join('components', name, path));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const root =
    rootIndex >= 0 ? resolve(argv[rootIndex + 1] ?? '.') : resolve(import.meta.dir, '../../..');
  const name = argv.find(
    (argument, index) => !argument.startsWith('--') && (rootIndex < 0 || index !== rootIndex + 1),
  );
  if (name === undefined) {
    process.stderr.write('Usage: bun scripts/create-package.ts <name> [--root <directory>]\n');
    process.exit(2);
  }
  const written = createPackage(root, name);
  process.stdout.write(`${written.join('\n')}\nRun \`bun install\` to link the new workspace.\n`);
}
