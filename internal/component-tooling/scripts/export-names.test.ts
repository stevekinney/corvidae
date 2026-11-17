import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { exportNames, formatExportNames } from './export-names.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'export-names-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

test('lists every kind of export once, sorted, following relative export-star barrels', () => {
  const root = fixture({
    'index.ts': `
export { default as Widget } from './widget/index.ts';
export type { WidgetProps, WidgetSize } from './widget/index.ts';
export { a as renamed, b } from './leaf.ts';
export * from './utilities.ts';
export * as ns from './utilities.ts';
export * from 'external-package';
export * from './missing.ts';
export const first = 1, second = 2;
export function run(): void {}
export class Engine {}
export interface Options {}
export type Mode = 'a' | 'b';
export enum Level { Low }
export default function main(): void {}
const hidden = 1;
function alsoHidden(): void {}
export { hidden as visible };
`,
    'leaf.ts': 'export const a = 1; export const b = 2;',
    'utilities.ts': `
export const fromUtilities = 1;
export type UtilityType = string;
export * from './nested.ts';
export * from './index.ts';
`,
    'nested.ts': 'export function nestedHelper(): void {}',
  });

  expect(exportNames(join(root, 'index.ts'))).toEqual({
    runtime: [
      'Engine',
      'Level',
      'Widget',
      'b',
      'default',
      'first',
      'fromUtilities',
      'nestedHelper',
      'ns',
      'renamed',
      'run',
      'second',
      'visible',
    ],
    types: ['Mode', 'Options', 'UtilityType', 'WidgetProps', 'WidgetSize'],
  });
});

test('an unreadable-as-TypeScript re-export contributes only its own name', () => {
  const root = fixture({
    'index.ts': `export { default as Button } from './button.svelte';\nexport * from './component.svelte';\n`,
  });
  expect(exportNames(join(root, 'index.ts'))).toEqual({
    runtime: ['Button'],
    types: [],
  });
});

test('splits type-only elements from runtime ones and prints one sorted list for each', () => {
  const root = fixture({
    'index.ts': `
export { type Alpha, beta } from './leaf.ts';
export type * from './types.ts';
export class Merged {}
export interface Merged {}
`,
    'leaf.ts': 'export interface Alpha {} export const beta = 1;',
    'types.ts': 'export interface FromTypes {} export const alsoType = 1;',
  });
  const names = exportNames(join(root, 'index.ts'));
  expect(names).toEqual({
    runtime: ['Merged', 'beta'],
    types: ['Alpha', 'FromTypes', 'alsoType'],
  });
  expect(formatExportNames(names)).toBe(
    '# runtime\nMerged\nbeta\n# types\nAlpha\nFromTypes\nalsoType\n',
  );
});

/**
 * `fixtures/root-export-names.txt` is the package root's export list: recorded before the root
 * barrel's component exports were generated (COR-2393), and rewritten when the root metadata
 * exports moved to `./<component>/schema`-style subpaths (COR-2078). The generated barrel may add
 * the names a new component's `index.ts` exports, but it never drops a recorded name or moves one
 * between the runtime and type lists. A change that removes a root export on purpose rewrites the
 * snapshot: `bun scripts/export-names.ts src/index.ts > scripts/fixtures/root-export-names.txt`.
 */
test('the package root still exports every recorded name, each of the same kind', () => {
  const packageRoot = join(import.meta.dir, '..');
  const recorded = readFileSync(join(import.meta.dir, 'fixtures', 'root-export-names.txt'), 'utf8');
  const [runtimeText = '', typesText = ''] = recorded.split('# types\n');
  const recordedRuntime = runtimeText.replace('# runtime\n', '').split('\n').filter(Boolean);
  const recordedTypes = typesText.split('\n').filter(Boolean);
  const current = exportNames(join(packageRoot, 'src', 'index.ts'));
  const runtime = new Set(current.runtime);
  const types = new Set(current.types);
  expect(recordedRuntime.filter((name) => !runtime.has(name))).toEqual([]);
  expect(recordedTypes.filter((name) => !types.has(name))).toEqual([]);
  // A name the snapshot lacks must come from a component added since, through its barrel.
  const componentNames = new Set<string>();
  const componentsRoot = join(packageRoot, 'src', 'components');
  for (const directory of readdirSync(componentsRoot)) {
    const barrel = join(componentsRoot, directory, 'index.ts');
    if (!existsSync(barrel)) continue;
    const names = exportNames(barrel);
    componentNames.add(
      directory.replaceAll(/(?:^|-)(\w)/g, (_, letter: string) => letter.toUpperCase()),
    );
    for (const name of [...names.runtime, ...names.types]) componentNames.add(name);
  }
  const recordedNames = new Set([...recordedRuntime, ...recordedTypes]);
  const added = [...current.runtime, ...current.types].filter(
    (name) => !recordedNames.has(name) && !componentNames.has(name),
  );
  expect(added).toEqual([]);
});
