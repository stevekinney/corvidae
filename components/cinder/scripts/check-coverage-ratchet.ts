import { checkCoverageRatchet } from '@lostgradient/testing/coverage-ratchet';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The flat coverage ratchet lives in `@lostgradient/testing/coverage-ratchet`; this entry point
 * only resolves which package to check. `--package-root <path>` checks another package, which is
 * how `@lostgradient/chat` shares it.
 */
export async function main(): Promise<void> {
  const packageRootArgumentIndex = process.argv.indexOf('--package-root');
  const packageRootArgument =
    packageRootArgumentIndex >= 0 ? process.argv[packageRootArgumentIndex + 1] : undefined;
  if (packageRootArgumentIndex >= 0 && packageRootArgument === undefined) {
    throw new Error('--package-root requires a path argument');
  }
  const packageRoot = packageRootArgument
    ? resolve(process.cwd(), packageRootArgument)
    : defaultPackageRoot;
  await checkCoverageRatchet({ packageRoot });
}

if (import.meta.main) await main();
