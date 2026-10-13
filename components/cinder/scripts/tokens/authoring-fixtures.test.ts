import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAuthoringCatalogue } from './authoring-catalogue.ts';
import {
  cloneCorpus,
  fixtureDirectory,
  loadProfileCorpus,
  readFixture,
} from './authoring-test-support.ts';
import { loadCorpus } from './generate.ts';
import { resolvedDirectory, tokensBaseCssPath } from './generator-configuration.ts';
import { resolveDocuments } from './resolve.ts';
import { TOKEN_TYPES, TokenValidationError, type TokenDocument } from './types.ts';
import { validateTokenDocumentSchema } from './validate-schema.ts';
import { assertValidResolverDocument, assertValidTokenDocument } from './validate.ts';
import { serializeTypedValue } from './value-formatters.ts';

const here = dirname(fileURLToPath(import.meta.url));

function issuesOf(run: () => void): Array<{ path: string; reason: string }> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenValidationError);
    return (error as TokenValidationError).issues;
  }
  throw new Error('expected the document to be rejected');
}

describe('all-types fixture', () => {
  const document = readFixture('all-types.tokens.json') as TokenDocument;

  test('is a valid document that resolves', () => {
    expect(() => assertValidTokenDocument(document, 'all-types.tokens.json')).not.toThrow();
    expect(Object.keys(resolveDocuments([document])).length).toBeGreaterThan(20);
  });

  test('has a specimen of every DTCG type the tooling supports', () => {
    const resolved = resolveDocuments([document]);
    const types = new Set(Object.values(resolved).map((token) => token.$type));
    for (const type of TOKEN_TYPES) expect(types.has(type)).toBe(true);
    expect(TOKEN_TYPES).toHaveLength(13);
  });

  test('exercises color spaces, the none keyword, groups, $root, $ref, and metadata', () => {
    const resolved = resolveDocuments([document]);
    expect(resolved['specimen.color.oklch-none']!.$value).toMatchObject({
      components: [0.5, 'none', 255],
    });
    expect(resolved['specimen.scale']).toBeDefined();
    expect(resolved['specimen.scale.large']).toBeDefined();
    expect(resolved['specimen.extended.rem']).toBeDefined();
    expect(resolved['specimen.pointer.alias']!.$value).toEqual({ value: 1, unit: 'rem' });
    expect(resolved['specimen.metadata.old']!.$deprecated).toBe('Use specimen.number.one.');
    expect(resolved['specimen.metadata.old']!.$extensions).toMatchObject({
      'com.example.vendor': { anything: true },
    });
  });
});

describe('negative fixtures', () => {
  const cases: Array<[string, string, string]> = [
    ['wrong-type', 'wrong.dimension-as-string.$value', 'must be object'],
    ['wrong-type', 'wrong.color-as-number.$value', 'must be object'],
    [
      'malformed-members',
      'malformed.color-short-components.$value.components',
      'must NOT have fewer than 3 items',
    ],
    ['malformed-members', 'malformed.duration-bad-unit.$value.unit', 'must be one of ["ms","s"]'],
    [
      'malformed-members',
      'malformed.shadow-missing-blur.$value',
      "must have required property 'blur'",
    ],
    ['color-alpha-none', 'alpha.out-of-range.$value.alpha', 'must be <= 1'],
    ['color-alpha-none', 'alpha.none.$value.alpha', 'must be number'],
    ['untyped-token', 'orphan', 'token has no $type and no inherited type'],
    ['root-not-token', 'group.$root', 'must NOT be valid'],
    ['ref-and-value', 'token', "must NOT have additional property '$value'"],
    ['invalid-deprecated', 'token.$deprecated', 'must be boolean'],
    ['invalid-extensions', 'token.$extensions', 'must be object'],
    ['extends-cycle', 'one', 'circular $extends reference'],
  ];

  test.each(cases)('%s reports %s: %s', (name, path, reason) => {
    const file = `${name}.tokens.json`;
    const issues = issuesOf(() => assertValidTokenDocument(readFixture(`negative/${file}`), file));
    expect(
      issues.map(
        (issue) => `${issue.path.replace(`${file}.`, '').replace(file, '')}: ${issue.reason}`,
      ),
    ).toContain(`${path}: ${reason}`);
  });

  test('a missing reference validates as a document and fails when resolved', () => {
    const document = readFixture('negative/missing-reference.tokens.json') as TokenDocument;
    expect(() => assertValidTokenDocument(document, 'missing-reference')).not.toThrow();
    expect(() => resolveDocuments([document])).toThrow(
      '{nowhere.defined}: reference target does not exist',
    );
  });

  test('a reference cycle validates as a document and fails when resolved', () => {
    const document = readFixture('negative/reference-cycle.tokens.json') as TokenDocument;
    expect(() => assertValidTokenDocument(document, 'reference-cycle')).not.toThrow();
    expect(() => resolveDocuments([document])).toThrow('cycle.a: circular token alias');
  });

  test('an unknown set in the resolution order is rejected', () => {
    const issues = issuesOf(() =>
      assertValidResolverDocument(readFixture('negative/unknown-set.resolver.json')),
    );
    expect(issues[0]!.reason).toBe(
      'resolutionOrder must reference an existing set or modifier: #/sets/missing',
    );
  });

  test('every fixture the matrix links exists', () => {
    for (const [name] of cases) {
      expect(existsSync(join(fixtureDirectory, 'negative', `${name}.tokens.json`))).toBe(true);
    }
  });
});

describe('strokeStyle is rejected by the schema before any Cinder rule runs', () => {
  const NAMED = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'outset', 'inset'];

  test.each(['none', 'hidden', 'banana', 'Solid', ''])('%p is not a stroke style', (value) => {
    const document = { sample: { $type: 'strokeStyle', $value: value } };
    const schemaIssues = issuesOf(() => validateTokenDocumentSchema(document, 'f.json'));
    expect(schemaIssues[0]).toEqual({
      path: 'f.json.sample.$value',
      reason: `must be one of ${JSON.stringify(NAMED)}`,
    });
    // The full load-time gate reports the schema's own issues, so the schema ran first.
    const fullIssues = issuesOf(() => assertValidTokenDocument(document, 'f.json'));
    expect(fullIssues).toEqual(schemaIssues);
  });

  test('the negative fixture rejects every invalid member', () => {
    const issues = issuesOf(() =>
      assertValidTokenDocument(readFixture('negative/invalid-stroke-style.tokens.json'), 'f.json'),
    );
    const paths = new Set(issues.map((issue) => issue.path));
    for (const member of ['none', 'hidden', 'unknown', 'empty-dash-array', 'bad-line-cap']) {
      expect([...paths].some((path) => path.startsWith(`f.json.stroke.${member}.`))).toBe(true);
    }
    expect(issues.some((issue) => issue.reason.startsWith('must be one of ["solid"'))).toBe(true);
  });

  test.each(NAMED)('accepts the named style %s', (value) => {
    expect(() =>
      assertValidTokenDocument({ sample: { $type: 'strokeStyle', $value: value } }, 'f.json'),
    ).not.toThrow();
  });

  test('accepts the object form with a dash array and a valid line cap', () => {
    const value = { dashArray: [{ value: 4, unit: 'px' }], lineCap: 'round' };
    expect(() =>
      assertValidTokenDocument({ sample: { $type: 'strokeStyle', $value: value } }, 'f.json'),
    ).not.toThrow();
  });
});

describe('the four CSS-only tokens are never portable', async () => {
  const fixture = readFixture('css-only.tokens.json') as TokenDocument;
  const expectations = Object.entries({
    'carousel.slide-size': fixture['carousel'],
    'carousel.aspect-ratio': fixture['carousel'],
    'code-block.height': fixture['code-block'],
    'spinner.indicator': fixture['spinner'],
  }).map(([path]) => {
    const [group, name] = path.split('.') as [string, string];
    const token = (fixture[group] as Record<string, any>)[name];
    return {
      path,
      cssRecipe: token.$extensions['com.lostgradient.cinder'].cssRecipe as string,
      byContext: token.$extensions['com.lostgradient.cinder.fixture'].expectedByContext as Record<
        string,
        string
      >,
    };
  });
  const corpus = await loadCorpus();
  const catalogue = buildAuthoringCatalogue(corpus.resolver, corpus.documentsByPath);
  const css = readFileSync(tokensBaseCssPath, 'utf8');

  test('the fixture is a valid document naming the four exceptions and six contexts each', () => {
    expect(() => assertValidTokenDocument(fixture, 'css-only.tokens.json')).not.toThrow();
    expect(expectations).toHaveLength(4);
    for (const expectation of expectations) {
      expect(Object.keys(expectation.byContext)).toHaveLength(6);
      expect(new Set(Object.values(expectation.byContext))).toEqual(
        new Set([expectation.cssRecipe]),
      );
    }
  });

  test.each(expectations)(
    '$path: the catalogue reports css-only status and the real CSS value',
    (expectation) => {
      const record = catalogue.records.find((candidate) => candidate.path === expectation.path)!;
      expect(record.disposition).toMatchObject({
        edit: 'css-only',
        cssExport: 'supported',
        dtcgExport: 'none',
        cssValue: expectation.cssRecipe,
      });
      for (const [context, value] of Object.entries(expectation.byContext)) {
        expect(record.variants.some((variant) => variant.contexts.includes(context))).toBe(true);
        expect(record.disposition.cssValue).toBe(value);
      }
    },
  );

  test.each(expectations)('$path: the generated CSS emits the real value', (expectation) => {
    const property = catalogue.records.find(
      (record) => record.path === expectation.path,
    )!.cssProperty;
    expect(css).toContain(`${property}: ${expectation.cssRecipe};`);
  });

  test.each(expectations)(
    '$path: no resolved-context file publishes a placeholder',
    (expectation) => {
      for (const name of ['light', 'dark', 'light-reduced-motion', 'dark-reduced-motion']) {
        const resolved = JSON.parse(readFileSync(join(resolvedDirectory, `${name}.json`), 'utf8'));
        expect(Object.keys(resolved)).not.toContain(expectation.path);
      }
    },
  );

  test('the fixture tokens classify as css-only when merged into a corpus', () => {
    const merged = cloneCorpus(loadProfileCorpus());
    const base = merged.documentsByPath.get('profile-base.tokens.json') as Record<string, unknown>;
    for (const group of ['carousel', 'code-block', 'spinner']) {
      base[group] = structuredClone((fixture as Record<string, unknown>)[group]);
    }
    const built = buildAuthoringCatalogue(merged.resolver, merged.documentsByPath);
    const cssOnly = built.records.filter((record) => record.disposition.edit === 'css-only');
    expect(cssOnly.map((record) => record.path).toSorted()).toEqual(
      expectations.map((expectation) => expectation.path).toSorted(),
    );
    for (const record of cssOnly) {
      const expected = expectations.find((candidate) => candidate.path === record.path)!;
      expect(record.disposition.cssValue).toBe(expected.cssRecipe);
    }
  });
});

describe('types without a direct CSS serialization', () => {
  test.each(['strokeStyle', 'border', 'transition', 'gradient', 'typography'] as const)(
    '%s requires a cssRecipe to reach CSS',
    (type) => {
      expect(() => serializeTypedValue(type, 'x', 'p.q')).toThrow(
        `No direct CSS serialization implemented for token type "${type}" at "p.q". Add a cssRecipe extension in the corpus, or extend serializeTypedValue.`,
      );
    },
  );
});

describe('the capability matrix document', () => {
  const documentPath = resolve(
    here,
    '..',
    '..',
    'documentation',
    'theme-builder-token-capabilities.md',
  );
  const markdown = readFileSync(documentPath, 'utf8');
  const ANCHORS: Record<string, Set<string>> = {
    format: new Set([
      'types',
      'color',
      'dimension',
      'font-family',
      'font-weight',
      'duration',
      'cubic-bezier',
      'number',
      'additional-types',
      'composite-types',
      'stroke-style',
      'string-value',
      'object-value',
      'fallbacks',
      'border',
      'transition',
      'shadow',
      'gradient',
      'typography',
      'aliases-references',
      'groups',
      'extending-groups',
      'type-0',
      'type-inheritance',
      'root-tokens-in-groups',
      'json-pointer-support',
      'json-pointer-syntax-required-support',
      'extensions',
      'extensions-0',
      'deprecated',
      'deprecated-0',
    ]),
    color: new Set([
      'format',
      'the-none-keyword',
      'using-the-none-keyword',
      'supported-color-spaces',
      'srgb',
      'oklch',
      'components',
    ]),
    resolver: new Set([
      'sets',
      'modifiers',
      'contexts',
      'default',
      'resolution-order',
      'ordering-of-sets-and-modifiers',
      'reference-objects',
      'resolution',
      'aliases',
      'extending',
      'invalid-pointers',
    ]),
  };

  test('every link is a 2025.10 module URL with a known anchor, or an existing local file', () => {
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(80);
    for (const link of links) {
      const external =
        /^https:\/\/www\.designtokens\.org\/tr\/2025\.10\/(format|color|resolver)\/#?([\w-]*)$/.exec(
          link,
        );
      if (external) {
        const [, module, anchor] = external;
        if (anchor) expect(ANCHORS[module!]!.has(anchor)).toBe(true);
        continue;
      }
      expect(link.startsWith('http')).toBe(false);
      expect(existsSync(resolve(dirname(documentPath), link))).toBe(true);
    }
  });

  test('every capability row names a section, a valid fixture, an invalid fixture, a diagnostic, and an owner test', () => {
    const rows = markdown
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('|') &&
          !line.startsWith('| ---') &&
          !line.startsWith('| Capability') &&
          !line.startsWith('| Token') &&
          !line.startsWith('| Case'),
      );
    const capabilityRows = rows.filter(
      (row) => row.includes('designtokens.org') || row.includes('.tokens.json'),
    );
    expect(capabilityRows.length).toBeGreaterThanOrEqual(35);
    for (const row of capabilityRows) {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      for (const cell of cells) expect(cell).not.toBe('');
    }
  });

  test('every DTCG type, CSS-only token, and the unsupported behaviors are named', () => {
    for (const type of TOKEN_TYPES) expect(markdown).toContain(`\`${type}\``);
    for (const path of [
      'carousel.slide-size',
      'carousel.aspect-ratio',
      'code-block.height',
      'spinner.indicator',
    ]) {
      expect(markdown).toContain(`\`${path}\``);
    }
    expect(markdown).toContain('## Unsupported-profile behavior');
    expect(markdown).toContain('## CSS-only tokens');
  });

  test('every type fixture the matrix reuses by reference exists', () => {
    for (const type of TOKEN_TYPES) {
      expect(existsSync(join(here, 'fixtures', 'valid', `${type}.tokens.json`))).toBe(true);
      expect(existsSync(join(here, 'fixtures', 'invalid', `${type}.tokens.json`))).toBe(true);
    }
  });
});
