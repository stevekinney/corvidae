import { describe, expect, test } from 'bun:test';

import {
  componentDocumentationProse,
  findProseReferenceFailures,
  proseSourcePaths,
} from './check-prose-component-references.ts';

const componentNames = new Set([
  'container',
  'experimental/live-component',
  'page-header',
  'virtual-list',
]);
const publicExports = new Set(['Button', 'ButtonSchema', 'Icon']);

describe('check-prose-component-references', () => {
  test('flags a genuinely dangling prose component reference', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `missing-component` instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('flags an unformatted direct component recommendation', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use missing-component to handle this state.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('flags every coordinated component recommendation', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use container or missing-component instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('flags a dangling Markdown-linked component recommendation', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use [`MissingComponent`](./missing-component.md) instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('does not treat a descriptive hyphenated compound as a component recommendation', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use an image-specific primitive for the media element.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('flags an unformatted example reference whose id is not registered', () => {
    expect(
      findProseReferenceFailures({
        source: 'Compose container (see its missing-component example).',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('accepts component names and deliberately referenced example ids', () => {
    expect(
      findProseReferenceFailures({
        source: 'Compose container (see its `hero-section` example).',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(['hero-section']),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('does not treat platform API identifiers as component references', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `aria-label` to provide the button name.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('does not treat another Lost Gradient package export as a Cinder component', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `DiffViewer` from `@lostgradient/editor` for document review.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('does not let a later external package reference exempt a dangling component', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `missing-component` instead. Use `DiffViewer` from `@lostgradient/editor`.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('does not accept a non-component public subpath as prose guidance', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `styles` instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'styles', filePath: 'fixture.md' }]);
  });

  test('normalizes PascalCase prose references to their component ids', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `VirtualList` instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('flags direct backticked PascalCase recommendations that do not exist', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `MissingComponent` to handle this state.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.md' }]);
  });

  test('does not let an example id validate a component recommendation', () => {
    expect(
      findProseReferenceFailures({
        source: 'Use `BottomSheet` instead.',
        filePath: 'fixture.md',
        componentNames,
        exampleIds: new Set(['bottom-sheet']),
        publicExports,
      }),
    ).toEqual([{ reference: 'bottom-sheet', filePath: 'fixture.md' }]);
  });

  test('validates backticked ids on Related components lines', () => {
    expect(
      findProseReferenceFailures({
        source: 'Related components: `container`, `missing-component`.',
        filePath: 'fixture.a11y.md',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'fixture.a11y.md' }]);
  });

  test('only scans component guidance rather than implementation or API documentation', () => {
    expect(
      componentDocumentationProse(
        'button.svelte',
        '<script>const label = `aria-label`;</script>\n<script module>/** @cinder @avoidWhen Use missing-component instead. */</script>',
      ),
    ).toContain('missing-component');
    expect(
      componentDocumentationProse(
        'button.a11y.md',
        'Use `aria-label` for a name.\n\n## Avoid when\n\n- Use missing-component instead.\n\n## Next',
      ),
    ).toContain('missing-component');
    expect(componentDocumentationProse('button.a11y.md', 'Use `aria-label` for a name.')).toContain(
      'aria-label',
    );
  });

  test('finds the @cinder JSDoc after preceding module-script statements', () => {
    expect(
      componentDocumentationProse(
        'button.svelte',
        "<script module>\nimport type { Snippet } from 'svelte';\n/** @cinder @avoidWhen Use `missing-component` instead. */\n</script>",
      ),
    ).toContain('missing-component');
  });

  test('checks prose in generated manifest metadata and package imports', () => {
    expect(
      findProseReferenceFailures({
        source: JSON.stringify({ purpose: 'Compose `missing-component` instead.' }),
        filePath: 'components.json',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'missing-component', filePath: 'components.json' }]);
    expect(
      findProseReferenceFailures({
        source: "import { MissingComponent } from '@lostgradient/cinder';",
        filePath: 'fixture.svelte',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([{ reference: 'MissingComponent', filePath: 'fixture.svelte' }]);
  });

  test('allows public root exports that are not component directory names', () => {
    expect(
      findProseReferenceFailures({
        source: "import '@lostgradient/cinder'; import { Icon } from '@lostgradient/cinder';",
        filePath: 'components.json',
        componentNames,
        exampleIds: new Set(),
        publicExports,
      }),
    ).toEqual([]);
  });

  test('preserves Cinder imports from fenced Markdown usage examples', () => {
    expect(
      componentDocumentationProse(
        'button/README.md',
        "Button introduction.\n\n## Usage\n\n```svelte\nimport { Button } from '@lostgradient/cinder';\n```",
      ),
    ).toContain('@lostgradient/cinder');
  });

  test('does not let example ids or parent directories validate imports', () => {
    expect(
      findProseReferenceFailures({
        source:
          "import { MissingComponent, ExperimentalMissingComponent } from '@lostgradient/cinder';",
        filePath: 'fixture.svelte',
        componentNames,
        exampleIds: new Set(['missing-component']),
        publicExports,
      }),
    ).toEqual([
      { reference: 'MissingComponent', filePath: 'fixture.svelte' },
      { reference: 'ExperimentalMissingComponent', filePath: 'fixture.svelte' },
    ]);
  });

  test('enumerates component prose files and the generated manifest', async () => {
    const files = await proseSourcePaths();
    expect(files).toContain('components.json');
    expect(files.some((filePath) => filePath.endsWith('/button.svelte'))).toBe(true);
    expect(files.some((filePath) => filePath.endsWith('/button/README.md'))).toBe(true);
  });
});

test('validates aliased and type-only imports against actual public names', () => {
  expect(
    findProseReferenceFailures({
      source:
        "import { Button as Action, type ButtonSchema as Schema, MissingComponent as Button } from '@lostgradient/cinder';",
      filePath: 'fixture.md',
      componentNames,
      exampleIds: new Set(),
      publicExports,
    }),
  ).toEqual([{ reference: 'MissingComponent', filePath: 'fixture.md' }]);
});

test('rejects former subpaths even when the component exists and rejects a default import', () => {
  expect(
    findProseReferenceFailures({
      source:
        "import Button from '@lostgradient/cinder'; import { Button } from '@lostgradient/cinder/button';",
      filePath: 'fixture.md',
      componentNames,
      exampleIds: new Set(),
      publicExports,
    }),
  ).toEqual([
    { reference: 'default', filePath: 'fixture.md' },
    { reference: '@lostgradient/cinder/button', filePath: 'fixture.md' },
  ]);
});

test('retains multiline root imports from fenced usage examples', () => {
  const prose = componentDocumentationProse(
    'button/README.md',
    "Introduction.\n\n## Usage\n\n```svelte\nimport {\n  Button,\n  type ButtonSchema,\n} from '@lostgradient/cinder';\n```",
  );
  expect(prose).toContain('ButtonSchema');
  expect(prose).toContain('@lostgradient/cinder');
});
