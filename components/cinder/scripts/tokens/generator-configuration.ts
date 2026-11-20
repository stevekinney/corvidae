import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import babelPlugin from 'prettier/plugins/babel';
import estreePlugin from 'prettier/plugins/estree';
import postcssPlugin from 'prettier/plugins/postcss';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(scriptDirectory, '..', '..');
/** The token corpus; defined here, not in `load.ts`, so the validator seed never imports validation. */
export const tokenRoot = join(packageRoot, 'src', 'tokens');
export const schemaDirectory = join(scriptDirectory, 'schemas');
export const tokensBaseCssPath = join(packageRoot, 'src', 'styles', 'tokens-base.css');
export const tokenUtilitiesCssPath = join(packageRoot, 'src', 'styles', 'token-utilities.css');
export const resolvedDirectory = join(tokenRoot, 'resolved');
export const runtimeDirectory = join(tokenRoot, 'runtime');
export const registryJsonPath = join(tokenRoot, 'registry.generated.json');
export const registryModulePath = join(tokenRoot, 'registry.generated.ts');
export const authoringCataloguePath = join(runtimeDirectory, 'authoring-catalogue.generated.ts');
export const tokenIndexPath = join(tokenRoot, 'index.json');
export const tokensDocPath = join(packageRoot, 'documentation', 'tokens.md');
/**
 * The generator outputs that stay in version control, because a person edits them or the generator
 * reads them back: the token sources it normalizes (`*.tokens.json`) and `documentation/tokens.md`,
 * whose authored sections it preserves. Every other output is ignored by git (`.gitignore` beside
 * this package's `package.json`), written by the `metadata` task (`tokens:seed`), and checked by `generator-outputs.integration.test.ts`.
 */
export function isVersionControlledOutput(path: string): boolean {
  return path === tokensDocPath || path.endsWith('.tokens.json');
}
export const REGENERATE_COMMAND = 'bun run --filter=@lostgradient/cinder tokens:generate';
export const PRETTIER_OPTIONS = {
  singleQuote: true,
  tabWidth: 2,
  printWidth: 100,
  endOfLine: 'lf',
} as const;
export const JSON_PLUGINS = [babelPlugin, estreePlugin];
export const CSS_PLUGINS = [postcssPlugin];
