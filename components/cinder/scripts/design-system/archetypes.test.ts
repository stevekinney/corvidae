import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHETYPE_STYLES_MARKER,
  archetypeExportName,
  archetypePreviewHtml,
  ARCHETYPES_GROUP,
  readArchetypePreviews,
} from './archetypes.ts';
import { buildBundleCss } from './css.ts';
import { archetypesRoot, assetsRoot, cinderRoot } from './paths.ts';

/**
 * The pages the design system must publish: the six the issue names at minimum, and the brand
 * book's other archetypes except Conversation, whose composer is the mounted `MarkdownEditor`.
 */
const REQUIRED_ARCHETYPES = [
  'browse',
  'collection',
  'detail',
  'flow',
  'focus-list',
  'form',
  'map',
  'overview',
  'queue',
  'record',
];

/**
 * Classes a component renders as structural hooks with no rule of their own, so `bundle.css` has no
 * selector for them. Each maps to the component source that renders it, which the test reads.
 */
const UNSTYLED_HOOKS: Record<string, string> = {
  'cinder-map-legend__label': 'src/components/map-legend/map-legend.svelte',
  'cinder-map-marker__label': 'src/components/map-marker/map-marker.svelte',
  'cinder-search-field__input': 'src/components/search-field/search-field.svelte',
};

const CARD_MARKER = `<!-- @dsCard group="${ARCHETYPES_GROUP}" height=100 subtitle="A page." -->`;
const PAGE = `${CARD_MARKER}\n<!doctype html>\n<html>\n<head>\n${ARCHETYPE_STYLES_MARKER}\n</head>\n<body></body>\n</html>\n`;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The pages and the shared layout, by file name, as checked in. */
function pageSources(): Array<{ name: string; text: string }> {
  return readdirSync(archetypesRoot)
    .filter((file) => file.endsWith('.html'))
    .toSorted()
    .map((file) => ({ name: file, text: read(join(archetypesRoot, file)) }));
}

/** The HTML fences of a Markdown file, each a fragment on its own. */
function htmlFences(markdown: string): string[] {
  return [...markdown.matchAll(/```html\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

/** Every markup fragment the design system ships by hand: each page, and each recipe fence. */
function markupFragments(): Array<{ name: string; text: string }> {
  const recipe = htmlFences(read(join(assetsRoot, 'recipe.md'))).map((text, index) => ({
    name: `recipe.md fence ${index + 1}`,
    text,
  }));
  return [...pageSources(), ...recipe];
}

/** The class tokens a fragment writes in `class="…"` attributes. */
function classesIn(markup: string): string[] {
  return [...markup.matchAll(/\bclass="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? '').split(/\s+/).filter(Boolean),
  );
}

let bundleSelectors: Set<string> | undefined;

/** Every `.cinder-*` class `bundle.css` styles, built from the real `all.css`. */
function stylesheetClasses(): Set<string> {
  bundleSelectors ??= new Set(
    [...buildBundleCss(join(cinderRoot, 'src/styles/all.css')).matchAll(/\.(cinder-[\w-]+)/g)].map(
      (match) => match[1] ?? '',
    ),
  );
  return bundleSelectors;
}

type TokenDocument = Record<string, { $extensions?: Record<string, { cssProperty?: string }> }>;

/** Every `--cinder-*` property the resolved light tokens declare. */
function tokenProperties(): Set<string> {
  const document = JSON.parse(
    read(join(cinderRoot, 'src/tokens/resolved/light.json')),
  ) as TokenDocument;
  return new Set(
    Object.values(document).flatMap((token) => {
      const property = token.$extensions?.['com.lostgradient.cinder']?.cssProperty;
      return property === undefined ? [] : [property];
    }),
  );
}

describe('archetypePreviewHtml', () => {
  test('inlines the shared layout where the marker stood', () => {
    expect(archetypePreviewHtml(PAGE, '.a { color: red; }\n')).toBe(
      `${CARD_MARKER}\n<!doctype html>\n<html>\n<head>\n<style>\n.a { color: red; }\n</style>\n</head>\n<body></body>\n</html>\n`,
    );
  });

  test('refuses a page without the marker, with it twice, or without its card marker', () => {
    expect(() => archetypePreviewHtml(PAGE.replace(ARCHETYPE_STYLES_MARKER, ''), '')).toThrow(
      'exactly once',
    );
    expect(() =>
      archetypePreviewHtml(PAGE.replace('</head>', `${ARCHETYPE_STYLES_MARKER}</head>`), ''),
    ).toThrow('exactly once');
    expect(() => archetypePreviewHtml(PAGE.replace(CARD_MARKER, ''), '')).toThrow('@dsCard');
  });

  test('refuses a page with no literal head and a stylesheet that ends its own style', () => {
    expect(() => archetypePreviewHtml(PAGE.replace('<head>', '<head lang="en">'), '')).toThrow(
      'literal <head>',
    );
    expect(() => archetypePreviewHtml(PAGE, 'a { content: "</style>"; }')).toThrow('</style');
  });
});

describe('archetypeExportName', () => {
  test('names the card folder after the page', () => {
    expect(archetypeExportName('browse')).toBe('ArchetypeBrowse');
    expect(archetypeExportName('focus-list')).toBe('ArchetypeFocusList');
  });
});

describe('the checked-in archetype pages', () => {
  const previews = readArchetypePreviews(archetypesRoot);

  test('publish every required archetype, each as one document', () => {
    const ids = previews.map((preview) => preview.id);
    for (const required of REQUIRED_ARCHETYPES) expect(ids).toContain(required);
    for (const preview of previews) {
      expect(preview.html).toMatch(
        /^<!-- @dsCard group="Page archetypes" height=\d+(?: width=\d+)? subtitle="/,
      );
      expect(preview.html).toContain('<style>');
      expect(preview.html).not.toContain(ARCHETYPE_STYLES_MARKER);
      expect(preview.html).toContain('<main class="arch">');
    }
  });

  test('leave the system stylesheets to the frame, as the cover card does', () => {
    for (const { name, text } of pageSources()) {
      expect({ name, links: /<link\b/.test(text) }).toEqual({ name, links: false });
      expect({ name, scripts: /<script\b/.test(text) }).toEqual({ name, scripts: false });
    }
  });
});

describe('the recipe and the archetype pages are built from real components', () => {
  test('every cinder class they write is styled by bundle.css', () => {
    const styled = stylesheetClasses();
    for (const { name, text } of markupFragments()) {
      const missing = [...new Set(classesIn(text))].filter(
        (token) =>
          token.startsWith('cinder-') &&
          !styled.has(token) &&
          !Object.hasOwn(UNSTYLED_HOOKS, token),
      );
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
  });

  test('the classes with no rule are ones the component itself renders', () => {
    for (const [token, source] of Object.entries(UNSTYLED_HOOKS)) {
      expect({ token, rendered: read(join(cinderRoot, source)).includes(token) }).toEqual({
        token,
        rendered: true,
      });
    }
  });

  test('every layout class a page writes is defined by the shared layout', () => {
    const layout = read(join(archetypesRoot, 'archetype.css'));
    for (const { name, text } of pageSources()) {
      const missing = [...new Set(classesIn(text))].filter(
        (token) => token.startsWith('arch') && !layout.includes(`.${token}`),
      );
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
  });

  test('every id is unique and every reference to one resolves', () => {
    for (const { name, text } of markupFragments()) {
      const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? '');
      const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
      expect({ name, duplicated }).toEqual({ name, duplicated: [] });
      const referenced = [
        ...text.matchAll(/\s(?:for|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g),
      ].flatMap((match) => (match[1] ?? '').split(/\s+/));
      const dangling = referenced.filter((id) => !ids.includes(id));
      expect({ name, dangling }).toEqual({ name, dangling: [] });
    }
  });

  test('use no middle dot as a separator', () => {
    for (const { name, text } of markupFragments()) {
      expect({ name, dot: text.includes(String.fromCodePoint(0xb7)) }).toEqual({
        name,
        dot: false,
      });
    }
  });
});

describe('the shared layout', () => {
  const layout = read(join(archetypesRoot, 'archetype.css'));

  test('uses only tokens Cinder declares', () => {
    const declared = tokenProperties();
    const used = [
      ...new Set([...layout.matchAll(/var\((--cinder-[\w-]+)/g)].map((m) => m[1] ?? '')),
    ];
    expect(used.filter((property) => !declared.has(property))).toEqual([]);
  });

  test('writes no colour of its own', () => {
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lch)\(/);
  });
});

describe('Select', () => {
  test('never shows the browser caret: it is appearance none with Cinder’s own chevron after it', () => {
    const css = read(join(cinderRoot, 'src/components/select/select.css'));
    expect(css).toMatch(/\.cinder-select\s*\{[^}]*appearance:\s*none/);
    for (const { name, text } of markupFragments()) {
      const selects = text.match(/<select\b/g)?.length ?? 0;
      const chevrons = text.match(/class="cinder-select-field__chevron"/g)?.length ?? 0;
      expect({ name, selects, chevrons }).toEqual({ name, selects, chevrons: selects });
    }
  });
});

describe('the recipe', () => {
  const recipe = read(join(assetsRoot, 'recipe.md'));

  test('gives class-level markup for every core component', () => {
    for (const heading of [
      '## Button',
      '## Chip',
      '## SegmentedControl',
      '## Input and Select',
      '## Section and Card',
      '## GroupedList rows',
      '## Badge and StatusDot',
      '## Callout',
      '## Banner',
      '## Navigation',
      '## Drawer',
    ]) {
      expect(recipe).toContain(heading);
    }
    expect(htmlFences(recipe).length).toBeGreaterThanOrEqual(11);
  });

  test('is published beside the brand book, which tells authors to use it', () => {
    const brandBook = read(join(assetsRoot, 'brand-book.md'));
    expect(brandBook).toContain('components/bundle.css');
    expect(brandBook).toContain('`recipe.md`');
    expect(brandBook).toContain('never hand-building component classes');
    for (const id of REQUIRED_ARCHETYPES) {
      expect(brandBook.toLowerCase()).toContain(id.replace('-', ' '));
    }
  });
});
