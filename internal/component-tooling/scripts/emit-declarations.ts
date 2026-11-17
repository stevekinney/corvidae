import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { emitDts } from 'svelte2tsx';

const require = createRequire(import.meta.url);

/**
 * Emits the `.d.ts` files of the Svelte package in the current working directory into
 * `.types/src`, mirroring `src`, so a consumer's `exports` `types` condition can point at
 * declarations while the `svelte` condition keeps reading source. Cinder owns this entry point
 * because it declares `svelte2tsx`; chat, editor, and terminal run it from their own directory.
 * It type-checks production source with `tsconfig.browser.json`, which excludes tests.
 *
 * A declaration that imports a JSON module keeps that import, and `emitDts` writes no JSON, so the
 * JSON files under `src` and the package's `components.json` are copied next to the declarations;
 * otherwise the import resolves to nothing and a consumer reads the module as `any`.
 */
export async function emitDeclarations(packageRoot: string): Promise<void> {
  const typesDirectory = resolve(packageRoot, '.types');
  await rm(typesDirectory, { force: true, recursive: true });
  await emitDts({
    libRoot: resolve(packageRoot, 'src'),
    declarationDir: join(typesDirectory, 'src'),
    svelteShimsPath: require.resolve('svelte2tsx/svelte-shims-v4.d.ts'),
    tsconfig: resolve(packageRoot, 'tsconfig.browser.json'),
  });
  const jsonFiles = [
    ...new Bun.Glob('src/**/*.json').scanSync({ cwd: packageRoot }),
    ...new Bun.Glob('components.json').scanSync({ cwd: packageRoot }),
  ];
  for (const file of jsonFiles) {
    const target = join(typesDirectory, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(packageRoot, file), target);
  }
}

if (import.meta.main) await emitDeclarations(process.cwd());
