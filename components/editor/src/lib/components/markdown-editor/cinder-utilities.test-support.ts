import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The utilities stylesheet Cinder's root stylesheet imports, wherever the package that holds it
 * keeps it: core's own `styles/utilities.css`, or the foundation package's once the Cinder split
 * moves it there (P-COR-101), which core then names by package specifier.
 */
export function cinderUtilitiesStylesheet(): string {
  const index = join(
    dirname(Bun.resolveSync('@lostgradient/cinder', import.meta.dir)),
    'styles',
    'index.css',
  );
  const specifier = /@import\s+['"]([^'"]*utilities\.css)['"]/.exec(
    readFileSync(index, 'utf8'),
  )?.[1];
  if (specifier === undefined) throw new Error(`${index} imports no utilities stylesheet.`);
  return specifier.startsWith('.')
    ? join(dirname(index), specifier)
    : Bun.resolveSync(specifier, dirname(index));
}

/**
 * Where an editor test reads Cinder's utilities stylesheet: through core's import while the editor
 * is a workspace package, and beside it in the published mirror's layout otherwise.
 */
export async function cinderUtilitiesStylesheetPath(): Promise<string | URL> {
  const manifest: { private?: boolean } = await Bun.file(
    new URL('../../../../package.json', import.meta.url),
  ).json();
  return manifest.private === true
    ? cinderUtilitiesStylesheet()
    : new URL('../../../../../components/src/styles/utilities.css', import.meta.url);
}
