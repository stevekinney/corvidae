import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CLASSIFIED, allUseSites, classify } from './border-tier-non-border-uses.test.ts';

describe('CIN-245: structural border tier classification', () => {
  test('every site in every workspace is classified', () => {
    const unclassified = allUseSites()
      .filter(([file, declaration]) => classify(file, declaration) === undefined)
      .map(([file, declaration]) => `${file}  ${declaration}`);

    expect(
      unclassified,
      'A structural border tier is used outside a border declaration at a site that is not ' +
        "classified. Every such use carries the tier's alpha somewhere a border would not: " +
        'decide whether it is a hairline, an area, a mix, or an occlusion, add it here, and ' +
        'record an area in documentation/css-audit/translucent-border-seams.md with its measured ' +
        'contrast.',
    ).toEqual([]);
  });

  test('no file grew a new occurrence of an already-classified declaration', () => {
    const counts = new Map<string, number>();
    for (const [file, declaration] of allUseSites()) {
      const key = `${file}  ${declaration}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const drifted: string[] = [];
    for (const [file, entries] of Object.entries(CLASSIFIED)) {
      for (const entry of entries) {
        const key = `${file}  ${entry.declaration}`;
        const actual = counts.get(key) ?? 0;
        const expected = entry.occurrences ?? 1;
        if (actual !== expected) drifted.push(`${key}  expected ${expected}, found ${actual}`);
      }
    }

    expect(
      drifted,
      'A classified declaration appears a different number of times than recorded. The same ' +
        'declaration text in one file can belong to two rules with different geometry, so a new ' +
        'occurrence has to be looked at rather than inheriting the existing category. Check what ' +
        'the new one paints, then update `occurrences` (or split the entry).',
    ).toEqual([]);
  });

  test('the classifications all still exist', () => {
    const sites = new Set(allUseSites().map(([file, declaration]) => `${file}  ${declaration}`));
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(CLASSIFIED)) {
      for (const entry of entries) {
        if (!sites.has(`${file}  ${entry.declaration}`))
          stale.push(`${file}  ${entry.declaration}`);
      }
    }
    expect(stale, 'A classified site no longer exists; remove it.').toEqual([]);
  });
});

/**
 * COR-1552: control borders keep at least 3:1, so once the structural tiers move to 5%, 9% and
 * 15% of the ink, a bordered button's resting edge cannot stay on `--cinder-border-strong`
 * (2.06:1 today, 1.37:1 at 15%). Each one reads `--cinder-border-control` (48%), or
 * `--cinder-button-border` for the secondary Button, which the token set aliases to the same.
 *
 * This is a source scan of the effective rule for each selector, named here rather than found by
 * a sweep, because the sweep cannot tell a button's resting edge from a card's.
 */
describe('COR-1552: bordered button resting edges keep the 3:1 control tier', () => {
  const COMPONENTS_ROOT = join(import.meta.dirname, '..', 'components');
  const CHAT_ROOT = join(import.meta.dirname, '..', '..', '..', 'chat', 'src', 'lib', 'components');
  const EDITOR_ROOT = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'editor',
    'src',
    'lib',
    'components',
  );

  /** Every `selector { body }` pair in the file, comments removed and whitespace collapsed. */
  function rules(path: string): Array<{ selector: string; body: string; index: number }> {
    const whole = readFileSync(path, 'utf8');
    // A Svelte component's markup has braces of its own, so only its `<style>` block is scanned.
    const styled = path.endsWith('.svelte') ? whole.slice(whole.indexOf('<style')) : whole;
    const source = styled.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
    const found: Array<{ selector: string; body: string; index: number }> = [];
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!
        .replace(/<style[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      found.push({ selector, body: match[2]!, index: match.index });
    }
    return found;
  }

  function declaration(body: string, property: string): string | undefined {
    return body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`))?.[1]?.trim();
  }

  type Edge = {
    file: string;
    selector: string;
    /** The longhand or shorthand that paints the resting edge. */
    property: 'border' | 'border-color';
    /** Narrow to the rule under this at-rule (the coarse-pointer action button). */
    expected: 'control' | 'button-token';
  };

  const EDGES: Edge[] = [
    {
      file: join(COMPONENTS_ROOT, 'copy-button', 'copy-button.css'),
      selector: '.cinder-copy-button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'load-more', 'load-more.css'),
      selector: '.cinder-load-more__button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'media-controls', 'media-controls.css'),
      selector: '.cinder-media-controls__button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'carousel', 'carousel.css'),
      selector: '.cinder-carousel__control, .cinder-carousel__dot',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'file-upload', 'file-upload.css'),
      selector: '.cinder-file-upload__retry',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'share-card', 'share-card.css'),
      selector: '.cinder-share-card__action',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'shortcut-field', 'shortcut-field.css'),
      selector: '.cinder-shortcut-field__clear',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'date-range-field', 'date-range-field.css'),
      selector: '.cinder-date-range-field__preset-btn',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'invocation-rule-builder', 'invocation-rule-builder.css'),
      selector: '.cinder-invocation-rule-builder__icon-btn',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'invocation-rule-builder', 'invocation-rule-builder.css'),
      selector: '.cinder-invocation-rule-builder__add-btn',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'tree', 'tree.css'),
      selector: '.cinder-tree-expand-all__button, .cinder-tree-select-all__button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'pagination', 'pagination.css'),
      selector:
        '.cinder-pagination__step:hover:not(:disabled), .cinder-pagination__page:hover:not([data-cinder-current])',
      property: 'border-color',
      expected: 'control',
    },
    {
      file: join(COMPONENTS_ROOT, 'chip', 'chip.css'),
      selector: "button.cinder-chip[data-cinder-variant='neutral']",
      property: 'border-color',
      expected: 'control',
    },
    {
      file: join(EDITOR_ROOT, 'review-editor', 'comment-list.svelte'),
      selector: '.comment-action',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(CHAT_ROOT, 'chat', 'message', 'chat-message.svelte'),
      selector: ':global(.chat-message-action-button)',
      property: 'border-color',
      expected: 'control',
    },
    {
      file: join(CHAT_ROOT, 'chat', 'container', 'chat-history-trigger.svelte'),
      selector: '.chat-history-trigger-button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(CHAT_ROOT, 'chat', 'container', 'chat-jump-controls.svelte'),
      selector: '.chat-jump-button',
      property: 'border',
      expected: 'control',
    },
    {
      file: join(CHAT_ROOT, 'chat', 'container', 'chat.svelte'),
      selector: '.chat-artifact-action',
      property: 'border',
      expected: 'control',
    },
  ];

  for (const edge of EDGES) {
    test(`${edge.selector} paints its resting edge in the control tier`, () => {
      const matching = rules(edge.file).filter((rule) => rule.selector === edge.selector);
      expect(matching.length, `no rule for ${edge.selector} in ${edge.file}`).toBeGreaterThan(0);
      const values = matching
        .map((rule) => declaration(rule.body, edge.property))
        .filter((value): value is string => value !== undefined);
      expect(values.length, `${edge.selector} does not declare ${edge.property}`).toBeGreaterThan(
        0,
      );
      for (const value of values) {
        expect(value).not.toContain('--cinder-border-strong');
        expect(value).toContain('var(--cinder-border-control)');
      }
    });
  }

  // The suggestion chip nests its hover and focus rules, which a flat rule scan cannot read, so
  // its edge is the one custom property its rule declares.
  test('.chat-suggestion-chip paints its resting edge in the control tier', () => {
    const source = readFileSync(
      join(CHAT_ROOT, 'chat', 'message', 'parts', 'suggestion-part.svelte'),
      'utf8',
    );
    const values = [...source.matchAll(/--cinder-chat-suggestion-border:\s*([^;]+);/g)].map(
      (match) => match[1]!.trim(),
    );
    expect(values).toEqual(['var(--cinder-border-control)']);
  });

  test('a disabled toggle chip keeps the muted edge, because the control rule sits above it', () => {
    const chipRules = rules(join(COMPONENTS_ROOT, 'chip', 'chip.css'));
    const control = chipRules.find(
      (rule) => rule.selector === "button.cinder-chip[data-cinder-variant='neutral']",
    );
    const disabled = chipRules.find((rule) =>
      rule.selector.startsWith('button.cinder-chip:disabled, .cinder-chip[data-cinder-disabled]'),
    );
    expect(control).toBeDefined();
    expect(disabled).toBeDefined();
    expect(declaration(disabled!.body, 'border-color')).toBe('var(--cinder-border-muted)');
    expect(control!.index).toBeLessThan(disabled!.index);
  });

  test('the secondary Button edge reads the control tier through --cinder-button-border', () => {
    const tokens = readFileSync(join(import.meta.dirname, 'tokens-base.css'), 'utf8');
    const declarations = [...tokens.matchAll(/--cinder-button-border:\s*([^;]+);/g)].map((match) =>
      match[1]!.trim(),
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const value of declarations) expect(value).toBe('var(--cinder-border-control)');
  });
});
