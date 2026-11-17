import { basename } from 'node:path';

/**
 * Whether `filePath` is one of a component's examples: a file in an `examples/` directory beside
 * the component's source (COR-2081). Examples are documentation that consumes the package through
 * its public name, the way an application does, so a check of what a component's own source may
 * do (its inline styles, its imports) skips them.
 */
export function isComponentExample(filePath: string): boolean {
  return filePath.replaceAll('\\', '/').split('/').includes('examples');
}

export function isExcludedComponentSource(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const fileName = basename(normalizedPath);
  return (
    normalizedPath.split('/').includes('__test-helpers__') ||
    fileName.includes('fixture') ||
    fileName.endsWith('.type-test.svelte') ||
    fileName.endsWith('-harness.svelte')
  );
}
