import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  checkRootRegistries,
  ROOT_REGISTRIES_COMMAND,
  writeRootRegistries,
} from './generate-root-registries.ts';

const packageRoot = join(import.meta.dir, '../../../components/cinder');
const INDEX = join('src', 'index.ts');
const COMPONENTS_CSS = join('src', 'styles', 'components.css');

const copies: string[] = [];

/** A copy of the package's `src` TypeScript and CSS, the inputs the generator reads. */
function copyPackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'cinder-root-registries-'));
  copies.push(root);
  cpSync(join(packageRoot, 'src'), join(root, 'src'), {
    recursive: true,
    filter: (source) =>
      !source.endsWith('.test.ts') &&
      (!/\.[a-z]+$/.test(source) || source.endsWith('.ts') || source.endsWith('.css')),
  });
  return root;
}

/** A minimal component directory, as `create-component.ts` would scaffold its barrel. */
function addComponent(root: string, name: string, pascal: string): void {
  const directory = join(root, 'src', 'components', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'index.ts'),
    [
      `import './${name}.css';`,
      `import ${pascal} from './${name}.svelte';`,
      '',
      `export default ${pascal};`,
      `export type { ${pascal}Props } from './${name}.types.ts';`,
      `export { ${pascal} };`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(directory, `${name}.css`), `.${name} {\n  display: block;\n}\n`);
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

/** The lines `after` adds to `before`, asserting it removes or reorders none of them. */
function addedLines(before: string, after: string): string[] {
  const original = before.split('\n');
  const added: string[] = [];
  let cursor = 0;
  for (const line of after.split('\n')) {
    if (cursor < original.length && line === original[cursor]) cursor += 1;
    else added.push(line);
  }
  expect(cursor).toBe(original.length);
  return added.filter((line) => line.trim() !== '');
}

let alpha: string;
let beta: string;

beforeAll(() => {
  alpha = copyPackage();
  beta = copyPackage();
});

afterAll(() => {
  for (const root of copies.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('root registries', () => {
  test('the checked-in src/index.ts and src/styles/components.css are current', async () => {
    expect(await checkRootRegistries(packageRoot)).toEqual([]);
  });

  test('two components added in parallel each change the registries only by regeneration', async () => {
    const baseIndex = read(alpha, INDEX);
    const baseCss = read(alpha, COMPONENTS_CSS);
    addComponent(alpha, 'drift-alpha', 'DriftAlpha');
    addComponent(beta, 'zz-drift-beta', 'ZzDriftBeta');

    // A component directory the registries do not list yet is drift that `--check` reports.
    for (const root of [alpha, beta]) {
      const issues = await checkRootRegistries(root);
      expect(issues.map((issue) => issue.file).toSorted()).toEqual(
        [INDEX, COMPONENTS_CSS].toSorted(),
      );
      expect(issues[0]?.reason).toContain(ROOT_REGISTRIES_COMMAND);
    }

    for (const [root, name, pascal] of [
      [alpha, 'drift-alpha', 'DriftAlpha'],
      [beta, 'zz-drift-beta', 'ZzDriftBeta'],
    ] as const) {
      const written = await writeRootRegistries(root);
      expect(written.toSorted()).toEqual([INDEX, COMPONENTS_CSS].toSorted());
      expect(await checkRootRegistries(root)).toEqual([]);
      expect(addedLines(baseIndex, read(root, INDEX))).toEqual([
        `export { default as ${pascal} } from './components/${name}/index.ts';`,
        `export type { ${pascal}Props } from './components/${name}/index.ts';`,
      ]);
      expect(addedLines(baseCss, read(root, COMPONENTS_CSS))).toEqual([
        `@import '../components/${name}/${name}.css';`,
      ]);
    }
  });

  test('a registry hand-edited out of step with the component directories fails the check', async () => {
    const root = copyPackage();
    const index = read(root, INDEX);
    const line = "export { default as Tooltip } from './components/tooltip/index.ts';\n";
    expect(index).toContain(line);
    writeFileSync(join(root, INDEX), index.replace(line, ''));
    const css = read(root, COMPONENTS_CSS);
    const tooltip = "@import '../components/tooltip/tooltip.css';\n";
    expect(css).toContain(tooltip);
    const first = "@import '../components/access-gate/access-gate.css';\n";
    writeFileSync(
      join(root, COMPONENTS_CSS),
      css.replace(tooltip, '').replace(first, tooltip + first),
    );

    const issues = await checkRootRegistries(root);
    expect(issues.map((issue) => issue.file).toSorted()).toEqual(
      [INDEX, COMPONENTS_CSS].toSorted(),
    );
    await writeRootRegistries(root);
    expect(read(root, INDEX)).toBe(index);
    expect(read(root, COMPONENTS_CSS)).toBe(css);
  });
});
