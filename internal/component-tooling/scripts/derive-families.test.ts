import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assignComponentFamilies,
  deriveFamilies,
  FamilyDerivationError,
  readRepositoryTree,
  readRules,
  SHARED_PACKAGES,
  TOOLING_ROOT,
  type DerivedFamilies,
  type FamilyRules,
} from './derive-families.ts';

const RULES: FamilyRules = {
  packageRoot: 'components/demo',
  componentsDirectory: 'src/components',
  families: [{ name: 'pair', components: ['pair', 'pair-item'], reason: 'compound' }],
  moves: [
    { patterns: ['src/_internal/pair-context.ts'], target: 'pair' },
    { patterns: ['src/test/fixtures/**'], target: 'by-imports' },
    { patterns: ['src/test/**'], target: 'tooling', helper: true },
    { patterns: ['src/_internal/**'], target: 'foundation' },
  ],
};

const svelte = (...imports: string[]) =>
  `<script lang="ts">\n${imports.map((path, index) => `  import Part${index} from '${path}';`).join('\n')}\n</script>\n`;

/** button and pair use foundation; card uses button; the helper and the pair context are clean. */
function baseTree(): Map<string, string> {
  return new Map([
    ['src/_internal/id.ts', 'export const id = 1;\n'],
    ['src/_internal/pair-context.ts', "import { id } from './id.ts';\nexport const key = id;\n"],
    ['src/components/button/button.svelte', svelte('../../_internal/id.ts')],
    ['src/components/button/button.test.ts', "import Button from './button.svelte';\n"],
    ['src/components/card/card.svelte', svelte('../button/button.svelte')],
    ['src/components/pair/pair.svelte', svelte('../../_internal/pair-context.ts')],
    ['src/components/pair-item/pair-item.svelte', svelte('../button/button.svelte')],
    ['src/test/aria.ts', 'export const expectAttribute = () => undefined;\n'],
  ]);
}

function derive(tree: Map<string, string>, rules: FamilyRules = RULES): DerivedFamilies {
  return deriveFamilies(tree, rules);
}

function problemsOf(tree: Map<string, string>, rules: FamilyRules = RULES): string[] {
  try {
    derive(tree, rules);
  } catch (error) {
    if (error instanceof FamilyDerivationError) return error.problems;
    throw error;
  }
  return [];
}

/** Every dependency sits in a strictly lower layer, which no cycle allows. */
function expectNoPackageCycle(derived: DerivedFamilies): void {
  for (const [name, entry] of Object.entries(derived.packages)) {
    for (const dependency of entry.dependencies) {
      const below = derived.packages[dependency]?.layer ?? Number.POSITIVE_INFINITY;
      expect({ name, dependency, below: below < entry.layer }).toEqual({
        name,
        dependency,
        below: true,
      });
    }
  }
}

describe('deriveFamilies', () => {
  test('groups components into families and layers the packages by their source imports', () => {
    const derived = derive(baseTree());
    expect(derived.packages['pair']?.components).toEqual(['pair', 'pair-item']);
    expect(derived.packages['card']?.dependencies).toEqual(['button']);
    expect(derived.packages['pair']?.dependencies).toEqual(['button', 'foundation']);
    expect(derived.packages['pair']?.modules).toEqual(['src/_internal/pair-context.ts']);
    expect(derived.packages['tooling']?.modules).toEqual(['src/test/aria.ts']);
    expect(derived.layers).toEqual([['foundation', 'tooling'], ['button'], ['card', 'pair']]);
    expect(derived.summary).toEqual({
      packages: 5,
      multiComponentFamilies: 1,
      singleComponentFamilies: 2,
      layerSizes: [2, 1, 2],
    });
    expectNoPackageCycle(derived);
  });

  test('a cycle between packages fails and names each import that closes it', () => {
    const tree = baseTree();
    tree.set('src/_internal/id.ts', "import Card from '../components/card/card.svelte';\n");
    const problems = problemsOf(tree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('form a cycle');
    expect(problems[0]).toContain(
      'foundation -> card (src/_internal/id.ts imports src/components/card/card.svelte)',
    );
  });

  test('a test helper that imports a component fails', () => {
    const tree = baseTree();
    tree.set('src/test/render-card.ts', "import Card from '../components/card/card.svelte';\n");
    expect(problemsOf(tree)).toEqual([
      'The test helper src/test/render-card.ts imports a component (src/components/card/card.svelte); a helper the tooling owns must be component-free.',
    ]);
  });

  test('a family test that would need a package depending on its family moves to core, with its importers', () => {
    const tree = baseTree();
    tree.set('src/components/button/button-in-card.fixture.svelte', svelte('../card/card.svelte'));
    tree.set(
      'src/components/button/button-in-card.test.ts',
      "import Fixture from './button-in-card.fixture.svelte';\n",
    );
    const derived = derive(tree);
    expect(derived.testMoves).toEqual([
      {
        file: 'src/components/button/button-in-card.fixture.svelte',
        from: 'button',
        to: 'core',
        because:
          'it needs "card", which depends on "button" (src/components/button/button-in-card.fixture.svelte -> src/components/card/card.svelte)',
      },
      {
        file: 'src/components/button/button-in-card.test.ts',
        from: 'button',
        to: 'core',
        because:
          'it imports or builds src/components/button/button-in-card.fixture.svelte, which core owns',
      },
    ]);
    expect(derived.packages['button']?.dependencies).toEqual(['foundation']);
    expectNoPackageCycle(derived);
  });

  test('tests that mount each other move the one that mounts a higher layer to core', () => {
    const tree = baseTree();
    // card (layer 2) uses button (layer 1); button's fixture mounts card and card's mounts button.
    tree.set('src/components/button/button-in-card.fixture.svelte', svelte('../card/card.svelte'));
    tree.set('src/components/card/card-footer.fixture.svelte', svelte('../button/button.svelte'));
    const derived = derive(tree);
    expect(derived.testMoves.map(({ file }) => file)).toEqual([
      'src/components/button/button-in-card.fixture.svelte',
    ]);
    expectNoPackageCycle(derived);
  });

  test('a foundation test that mounts a family moves to core', () => {
    const tree = baseTree();
    tree.set(
      'src/_internal/id.test.ts',
      "import Button from '../components/button/button.svelte';\n",
    );
    const derived = derive(tree);
    expect(derived.testMoves.map(({ file, from }) => `${from} ${file}`)).toEqual([
      'foundation src/_internal/id.test.ts',
    ]);
  });

  test('a family may import another family module while the graph stays acyclic', () => {
    const tree = baseTree();
    tree.set('src/components/card/card.svelte', svelte('../../_internal/pair-context.ts'));
    const derived = derive(tree);
    expect(derived.packages['card']?.dependencies).toEqual(['pair']);
    expect(derived.subpathExports).toEqual({ 'src/_internal/pair-context.ts': ['card'] });
  });

  test('a file no move row places fails', () => {
    const tree = baseTree();
    tree.set('src/loose.ts', 'export const loose = true;\n');
    expect(problemsOf(tree)).toEqual([
      'No move row places src/loose.ts: add it to a row in family-rules.json.',
    ]);
  });

  test('a private component directory no family names fails', () => {
    const tree = baseTree();
    tree.set('src/components/_secret/secret.svelte', svelte());
    expect(problemsOf(tree)[0]).toContain(
      'No rule places the private component directory "_secret"',
    );
  });

  test('a family member that is not a component directory fails', () => {
    const tree = baseTree();
    tree.delete('src/components/pair-item/pair-item.svelte');
    expect(problemsOf(tree)[0]).toContain('Family "pair" names "pair-item"');
  });

  test('a fixture goes to the family whose tests import it when that family can mount it', () => {
    const tree = baseTree();
    tree.set('src/test/fixtures/card-fixture.svelte', svelte('../../components/card/card.svelte'));
    tree.set(
      'src/components/card/card.test.ts',
      "import Fixture from '../../test/fixtures/card-fixture.svelte';\n",
    );
    const derived = derive(tree);
    expect(derived.packages['card']?.modules).toEqual(['src/test/fixtures/card-fixture.svelte']);
    expect(derived.testMoves).toEqual([]);
  });

  test('a fixture two families import goes to core with every test that imports it', () => {
    const tree = baseTree();
    tree.set('src/test/fixtures/card-fixture.svelte', svelte('../../components/card/card.svelte'));
    tree.set(
      'src/components/card/card.test.ts',
      "import Fixture from '../../test/fixtures/card-fixture.svelte';\n",
    );
    tree.set(
      'src/components/pair/pair.test.ts',
      "import Fixture from '../../test/fixtures/card-fixture.svelte';\n",
    );
    const derived = derive(tree);
    expect(derived.packages['core']?.modules).toEqual(['src/test/fixtures/card-fixture.svelte']);
    expect(derived.testMoves.map(({ file, from, to }) => ({ file, from, to }))).toEqual([
      { file: 'src/components/card/card.test.ts', from: 'card', to: 'core' },
      { file: 'src/components/pair/pair.test.ts', from: 'pair', to: 'core' },
      { file: 'src/test/fixtures/card-fixture.svelte', from: 'by-imports', to: 'core' },
    ]);
    expectNoPackageCycle(derived);
  });
});

describe('family-rules.json', () => {
  const rules = readRules();
  const fixture = JSON.parse(
    readFileSync(join(TOOLING_ROOT, 'family-rules.fixture.json'), 'utf8'),
  ) as FamilyRules;
  // Core joined with every package already extracted from it, the tree the map was derived from.
  const { files: tree, split } = readRepositoryTree(rules);

  test('derives a map of Cinder with no package cycle, tokens and tooling at the bottom', () => {
    const derived = deriveFamilies(tree, rules, split);
    expectNoPackageCycle(derived);
    expect(derived.packages['tokens']?.dependencies).toEqual([]);
    // Once its modules have left Cinder, the tooling owns nothing in Cinder's tree.
    expect(derived.packages['tooling']?.dependencies ?? []).toEqual([]);
  });

  test('holds the reviewed appendix in family-rules.fixture.json', () => {
    expect(rules).toEqual(fixture);
  });

  test('places every Cinder component directory in exactly one family', () => {
    const { families, problems } = assignComponentFamilies(tree, rules);
    expect(problems).toEqual([]);
    const memberships = rules.families.flatMap((family) => family.components);
    expect(new Set(memberships).size).toBe(memberships.length);
    expect(memberships.filter((component) => !families.has(component))).toEqual([]);
  });

  test('lists exactly the fixture multi-component families', () => {
    const { families } = assignComponentFamilies(tree, rules);
    const counts = new Map<string, number>();
    for (const family of families.values()) counts.set(family, (counts.get(family) ?? 0) + 1);
    const multiComponent = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    expect(multiComponent.toSorted()).toEqual(
      fixture.families.map((family) => family.name).toSorted(),
    );
  });

  test('moves every module to a family, a shared package, or a decision the derivation makes', () => {
    const { families } = assignComponentFamilies(tree, rules);
    const familyNames = new Set(families.values());
    const targets = rules.moves
      .map((row) => row.target)
      .filter(
        (target) =>
          !familyNames.has(target) &&
          !(SHARED_PACKAGES as readonly string[]).includes(target) &&
          target !== 'by-imports' &&
          target !== 'companion',
      );
    expect(targets).toEqual([]);
  });
});
