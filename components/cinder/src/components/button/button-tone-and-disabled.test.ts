/// <reference lib="dom" />
/**
 * COR-1821: a primary Button never takes a status tone from its container, and a disabled Button
 * looks disabled the same way in every variant.
 *
 * happy-dom does not compute styles from stylesheets, so the visual halves are pinned against the
 * CSS source with `postcss`, as `callout.css.test.ts` does. The render half proves the structure:
 * the Button inside a danger Card is still a primary Button.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { parse, type AtRule, type Container, type Document, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';

import { setupHappyDom } from '@lostgradient/testing';

import type { ButtonVariant } from './button.types.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: InDangerCard } = await import('./button-in-danger-card.fixture.svelte');

const sourceDirectory = fileURLToPath(new URL('../..', import.meta.url));

function loadCss(path: string): string {
  return readFileSync(`${sourceDirectory}/${path}`, 'utf8');
}

const buttonCss = loadCss('components/button/button.css');

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'soft',
  'danger',
  'soft-danger',
  'ghost',
  'ghost-danger',
];

function isInsideMedia(rule: Rule): boolean {
  let ancestor: Container | Document | undefined = rule.parent;
  while (ancestor !== undefined) {
    if (ancestor.type === 'atrule' && (ancestor as AtRule).name !== 'layer') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

const loadingExcluded = /:not\(\s*\[data-cinder-loading\]\s*\)/;
const disabledSelector = /:disabled|\[aria-disabled='true'\]/;

/**
 * The declarations a disabled (not loading) button of `variant` ends up with: the base disabled
 * rule, then the variant's own, then (for an icon-only button) the icon-only ones, last rule wins.
 */
function disabledDeclarations(variant: ButtonVariant, iconOnly = false): Map<string, string> {
  const merged = new Map<string, string>();
  const rules: Rule[] = [];
  parse(buttonCss).walkRules((rule) => {
    if (!isInsideMedia(rule)) rules.push(rule);
  });
  const matching = (applies: (selector: string) => boolean) =>
    rules.filter((rule) =>
      rule.selectors.some(
        (selector) =>
          disabledSelector.test(selector) && loadingExcluded.test(selector) && applies(selector),
      ),
    );
  const hasVariant = (selector: string) => selector.includes(`[data-cinder-variant='${variant}']`);
  const isIconOnly = (selector: string) => selector.includes('[data-cinder-icon-only]');
  const layers = [
    matching((selector) => !/\[data-cinder-variant=/.test(selector)),
    matching((selector) => hasVariant(selector) && !isIconOnly(selector)),
    ...(iconOnly ? [matching((selector) => hasVariant(selector) && isIconOnly(selector))] : []),
  ];
  for (const rule of layers.flat()) {
    rule.walkDecls((declaration) => {
      merged.set(declaration.prop, declaration.value);
    });
  }
  return merged;
}

describe('Button disabled looks disabled in every variant', () => {
  test('the variant list covers every variant the stylesheet knows', () => {
    const named = new Set(
      [...buttonCss.matchAll(/\[data-cinder-variant='([a-z-]+)'\]/g)].map((match) => match[1]),
    );
    expect([...named].sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [...VARIANTS].sort((a, b) => a.localeCompare(b)),
    );
  });

  test.each(VARIANTS)('a disabled %s button reads as disabled, not as its tone', (variant) => {
    const declarations = disabledDeclarations(variant);
    expect(declarations.get('color')).toBe('var(--cinder-text-disabled)');
    expect(['var(--cinder-surface-inset)', 'transparent']).toContain(
      declarations.get('background') ?? '',
    );
    expect(['var(--cinder-border-muted)', 'transparent']).toContain(
      declarations.get('border-color') ?? '',
    );
  });

  test.each(['ghost', 'ghost-danger'] as const)(
    'a disabled icon-only %s button reads as disabled, not as its tone',
    (variant) => {
      const declarations = disabledDeclarations(variant, true);
      expect(declarations.get('color')).toBe('var(--cinder-text-disabled)');
      expect(declarations.get('background')).toBe('var(--cinder-surface-inset)');
    },
  );

  test('no disabled rule paints a status or accent tone', () => {
    const rules: string[] = [];
    parse(buttonCss).walkRules((rule) => {
      if (!rule.selector.includes(':disabled') && !rule.selector.includes("[aria-disabled='true']"))
        return;
      if (
        /:hover|:active|:focus-visible|\[aria-pressed/.test(
          rule.selector.replace(/:not\([^)]*\)/g, ''),
        )
      )
        return;
      rule.walkDecls((declaration) => {
        if (/--cinder-(?:status|accent)-/.test(declaration.value)) {
          rules.push(`${rule.selector} { ${declaration.prop}: ${declaration.value} }`);
        }
      });
    });
    expect(rules).toEqual([]);
  });

  test('disabled opacity comes from one place, not from each variant', () => {
    const rules: string[] = [];
    parse(buttonCss).walkRules((rule) => {
      if (!rule.selector.includes(':disabled') && !rule.selector.includes("[aria-disabled='true']"))
        return;
      rule.walkDecls('opacity', () => {
        rules.push(rule.selector);
      });
    });
    expect(rules).toEqual([]);
  });
});

describe('a primary Button never takes a container tone', () => {
  test('a primary Button inside a danger Card renders the primary tone', () => {
    const { container } = render(InDangerCard);
    const card = container.querySelector('.cinder-card');
    const primary = container.querySelector("button[data-cinder-variant='primary']");
    expect(card?.getAttribute('data-cinder-tone')).toBe('danger');
    expect(primary).not.toBeNull();
    expect(primary?.closest('.cinder-card')).toBe(card);
    expect(primary?.getAttribute('data-cinder-variant')).toBe('primary');
  });

  test('the primary face reads the accent tokens, which no container rebinds', () => {
    const primary = parse(buttonCss);
    let background: string | undefined;
    let color: string | undefined;
    primary.walkRules((rule) => {
      if (rule.selector !== ".cinder-button[data-cinder-variant='primary']") return;
      rule.walkDecls('background', (declaration) => {
        background = declaration.value;
      });
      rule.walkDecls('color', (declaration) => {
        color = declaration.value;
      });
    });
    expect(background).toBe('var(--cinder-accent-solid)');
    expect(color).toBe('var(--cinder-accent-contrast)');
  });

  test('no Cinder stylesheet re-tones a Button from a tone, variant or status ancestor', () => {
    const offenders: string[] = [];
    const files = new Bun.Glob('**/*.css').scanSync({ cwd: sourceDirectory });
    for (const file of files) {
      if (file === 'components/button/button.css') continue;
      parse(loadCss(file)).walkRules((rule) => {
        selectorParser((selectors) => {
          selectors.each((selector) => {
            const compounds: string[] = [''];
            selector.each((node) => {
              if (node.type === 'combinator') compounds.push('');
              else compounds[compounds.length - 1] += node.toString();
            });
            const buttonIndex = compounds.findIndex((compound) =>
              /\.cinder-button(?![\w-])/.test(compound),
            );
            if (buttonIndex <= 0) return;
            const ancestors = compounds.slice(0, buttonIndex).join(' ');
            if (/\[data-cinder-(?:tone|variant|severity|status|state)\b/.test(ancestors)) {
              offenders.push(`${file}: ${selector.toString().trim()}`);
            }
          });
        }).processSync(rule.selector);
      });
    }
    expect(offenders).toEqual([]);
  });
});
