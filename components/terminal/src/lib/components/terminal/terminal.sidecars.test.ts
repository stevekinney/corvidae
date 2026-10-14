import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import ts from 'typescript';

import { THEME_TOKENS } from './terminal-theme.ts';
import schema from './terminal.schema.ts';
import variables from './terminal.variables.ts';

const directory = import.meta.dir;
const packageRoot = join(directory, '../../../..');
const read = (name: string) => Bun.file(join(directory, name)).text();
const readJson = async (name: string) => JSON.parse(await read(name)) as unknown;

/** The members of the exported `TerminalProps` object type and `TerminalState` union, from source. */
async function readTypesSource() {
  const source = ts.createSourceFile(
    'terminal.types.ts',
    await read('terminal.types.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  const props: Array<{ name: string; optional: boolean }> = [];
  const states: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'TerminalProps') {
      const collect = (type: ts.TypeNode): void => {
        if (ts.isIntersectionTypeNode(type)) type.types.forEach(collect);
        else if (ts.isTypeLiteralNode(type)) {
          for (const member of type.members) {
            if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
              props.push({ name: member.name.text, optional: member.questionToken !== undefined });
            }
          }
        }
      };
      collect(node.type);
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'TerminalState') {
      const union = node.type;
      if (ts.isUnionTypeNode(union)) {
        for (const member of union.types) {
          if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
            states.push(member.literal.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { props, states };
}

describe('terminal.schema', () => {
  test('the committed JSON schema matches the typed schema', async () => {
    expect(await readJson('terminal.schema.json')).toEqual(schema);
  });

  test('describes exactly the props declared in terminal.types.ts', async () => {
    const { props } = await readTypesSource();
    const described = [
      ...Object.keys(schema.properties),
      ...schema.metadata.unsupportedProps.map(({ name }) => name),
    ];
    expect(described.toSorted()).toEqual(props.map(({ name }) => name).toSorted());
    expect(new Set(described).size).toBe(described.length);
  });

  test('marks as required exactly the props declared without a question mark', async () => {
    const { props } = await readTypesSource();
    const required = props.filter(({ optional }) => !optional).map(({ name }) => name);
    expect([...schema.required]).toEqual(required);
    const unsupportedRequired = schema.metadata.unsupportedProps
      .filter(({ required }) => required === true)
      .map(({ name }) => name);
    expect(unsupportedRequired).toEqual([]);
  });

  test('lists exactly the TerminalState members as the state enum', async () => {
    const { states } = await readTypesSource();
    const state = schema.properties['state'] as { enum: string[] };
    expect([...state.enum]).toEqual(states);
    expect(states).toHaveLength(12);
  });

  test('describes ownerGeometry with the same bounds the wire schema allows', () => {
    const owner = schema.properties['ownerGeometry'] as {
      properties: Record<string, { minimum: number; maximum: number }>;
    };
    expect(owner.properties['columns']).toMatchObject({ minimum: 1, maximum: 65535 });
    expect(owner.properties['rows']).toMatchObject({ minimum: 1, maximum: 65535 });
  });
});

describe('terminal.variables', () => {
  test('the committed JSON matches the typed list', async () => {
    expect(await readJson('terminal.variables.json')).toEqual(variables);
  });

  test('lists exactly the custom properties the stylesheet and the theme bridge read', async () => {
    const css = await read('terminal.css');
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!));
    for (const token of Object.values(THEME_TOKENS)) used.add(token);
    expect([...variables].toSorted()).toEqual([...used].toSorted());
  });

  test('is sorted and free of duplicates', () => {
    expect([...variables]).toEqual([...variables].toSorted());
    expect(new Set(variables).size).toBe(variables.length);
  });
});

type Example = { id: string; title: string; description: string; code: string; featured?: true };
type ExamplesFile = { component: string; import: string; examples: Example[] };

describe('terminal.examples', () => {
  test('names the component and the package import', async () => {
    const file = (await readJson('terminal.examples.json')) as ExamplesFile;
    expect(file.component).toBe('terminal');
    expect(file.import).toBe('@lostgradient/terminal');
    expect(file.examples.length).toBeGreaterThan(0);
  });

  test('every example has a unique kebab-case id and complete text', async () => {
    const { examples } = (await readJson('terminal.examples.json')) as ExamplesFile;
    const ids = examples.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const example of examples) {
      expect(example.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.description.length).toBeGreaterThan(0);
      expect(example.code.length).toBeGreaterThan(0);
    }
  });

  test('every example imports from the package and compiles as a Svelte component', async () => {
    const { examples } = (await readJson('terminal.examples.json')) as ExamplesFile;
    for (const example of examples) {
      expect(example.code).toContain("from '@lostgradient/terminal'");
      expect(() =>
        compile(example.code, { generate: 'server', filename: `${example.id}.svelte` }),
      ).not.toThrow();
    }
  });
});

type Manifest = {
  package: { name: string };
  components: Array<{
    id: string;
    name: string;
    exportName: string;
    import: string;
    purpose: string;
    hasExamples: boolean;
    related: string[];
    useWhen: string[];
    avoidWhen: Array<{ reason: string }>;
    artifacts: Record<string, string>;
  }>;
};

describe('components.json', () => {
  test('describes the one Terminal component the package exports', async () => {
    const manifest = JSON.parse(
      await Bun.file(join(packageRoot, 'components.json')).text(),
    ) as Manifest;
    const packageJson = JSON.parse(await Bun.file(join(packageRoot, 'package.json')).text()) as {
      name: string;
    };
    expect(manifest.package.name).toBe(packageJson.name);
    expect(manifest.components).toHaveLength(1);
    const [component] = manifest.components;
    expect(component).toMatchObject({
      id: 'terminal',
      name: 'Terminal',
      exportName: 'Terminal',
      import: packageJson.name,
      hasExamples: true,
    });
    for (const artifact of Object.values(component!.artifacts))
      expect(artifact).toBe(packageJson.name);
  });

  test('repeats the doc tags of terminal.svelte, so the two cannot drift', async () => {
    const manifest = JSON.parse(
      await Bun.file(join(packageRoot, 'components.json')).text(),
    ) as Manifest;
    const [component] = manifest.components;
    const source = await read('terminal.svelte');
    const tag = (name: string) =>
      [...source.matchAll(new RegExp(`@${name} (.+)`, 'g'))].map((match) => match[1]!.trim());
    expect([component!.purpose]).toEqual(tag('purpose'));
    expect(component!.useWhen).toEqual(tag('useWhen'));
    expect(component!.avoidWhen.map(({ reason }) => reason)).toEqual(tag('avoidWhen'));
    expect(component!.related.join(', ')).toBe(tag('related')[0]!);
  });
});

describe('terminal.css', () => {
  test('layers under cinder.components and uses only Cinder tokens for color', async () => {
    const css = await read('terminal.css');
    expect(css).toContain(
      '@layer cinder.tokens, cinder.foundation, cinder.components, cinder.utilities;',
    );
    expect(css).toContain('@layer cinder.components {');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/);
  });

  test('keeps the fit-measured engine host paddingless and insets the engine element instead', async () => {
    const source = await read('terminal.css');
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const bodyOf = (selector: string) =>
      rules
        .filter((rule) => rule[1]!.split(',').some((part) => part.trim() === selector))
        .map((rule) => rule[2]!)
        .join('\n');
    // The addon measures this element's computed size and never subtracts its padding.
    expect(bodyOf('.cinder-terminal__viewport')).not.toMatch(/\bpadding(?:-[a-z]+)?\s*:/);
    expect(bodyOf(".cinder-terminal__viewport[data-grid='owner']")).not.toMatch(
      /\bpadding(?:-[a-z]+)?\s*:/,
    );
    // The addon does subtract the engine element's own padding.
    expect(bodyOf('.cinder-terminal__viewport .xterm')).toMatch(/\bpadding\s*:/);
  });

  test('turns non-essential motion off for reduced motion', async () => {
    const css = await read('terminal.css');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('transition: none');
    expect(block).toContain('animation: none');
  });

  test('keeps a visible focus indicator, and a system-color one under forced colors', async () => {
    const css = await read('terminal.css');
    expect(css).toContain('.cinder-terminal__viewport:focus-within');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('outline-color: Highlight');
  });

  test('states an error in text as well as color, with a color-independent forced-colors treatment', async () => {
    const css = await read('terminal.css');
    expect(css).toContain("[data-state='engine-load-failed'] .cinder-terminal__message");
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('CanvasText');
  });
});

describe('component files', () => {
  test.each([
    'terminal.svelte',
    'terminal.types.ts',
    'index.ts',
    'terminal.css',
    'README.md',
    'terminal.a11y.md',
    'terminal.schema.ts',
    'terminal.schema.json',
    'terminal.variables.ts',
    'terminal.variables.json',
    'terminal.examples.json',
  ])('%s exists', (name) => {
    expect(existsSync(join(directory, name))).toBe(true);
  });

  test('the workspace root has its manifest and coverage ratchet', () => {
    expect(existsSync(join(packageRoot, 'components.json'))).toBe(true);
    expect(existsSync(join(packageRoot, 'coverage-ratchet.json'))).toBe(true);
  });

  test('the README documents every public prop', async () => {
    const readme = await read('README.md');
    const { props } = await readTypesSource();
    for (const { name } of props) {
      if (name === 'class') continue;
      expect(readme).toContain(`\`${name}\``);
    }
  });
});
