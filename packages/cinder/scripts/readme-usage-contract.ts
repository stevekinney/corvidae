import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type ReadmeComponent = { componentId: string; directory: string };

export const COMPOSE_ONLY_LEAF_EXEMPTIONS = new Set([
  'accordion-item',
  'choice-grid-item',
  'dropdown-item',
  'dropdown-label',
  'dropdown-menu',
  'dropdown-separator',
  'dropdown-trigger',
  'feed-boundary',
  'feed-event',
  'grid-list-item',
  'side-navigation-group',
  'side-navigation-item',
  'statistic',
  'tab',
  'tab-list',
  'tab-panel',
  'table-body',
  'table-cell',
  'table-header',
  'table-header-cell',
  'table-row',
  'tree-item',
]);

export const DOTTED_NAMESPACE_ONLY_EXEMPTIONS = new Set([
  'bento-cell',
  'grid-item',
  'speed-dial-action',
]);

export function discoverReadmeComponents(rootDirectory: string): ReadonlyArray<ReadmeComponent> {
  const results: ReadmeComponent[] = [];
  for (const name of readdirSync(rootDirectory).toSorted()) {
    if (name.startsWith('_') || name === 'icons') continue;
    const entryPath = join(rootDirectory, name);
    if (!existsSync(entryPath)) continue;
    if (name === 'experimental') {
      for (const subName of readdirSync(entryPath).toSorted()) {
        if (subName.startsWith('_')) continue;
        const directory = join(entryPath, subName);
        if (existsSync(join(directory, 'README.md')))
          results.push({ componentId: subName, directory });
      }
      continue;
    }
    if (existsSync(join(entryPath, 'README.md')))
      results.push({ componentId: name, directory: entryPath });
  }
  return results;
}

export function toIdentifier(id: string): string {
  return id
    .split(/[-/]/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join('');
}
