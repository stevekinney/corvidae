/// <reference lib="dom" />
/**
 * COR-2313: the filled appearance of Input, Select, Textarea and SearchField.
 *
 * A filled field is an inset fill inside the same 1px `--cinder-control-border` edge, so the
 * boundary keeps its 3:1 contrast where the fill alone measures about 1.1:1. These tests pin
 * what each component renders (`data-cinder-appearance`, the group modifier class), the shape of
 * the CSS that defines the rest, hover, focus, invalid, disabled and read-only states, the
 * comfortable-density default, and the edge's contrast against the fill. Computed values in a
 * browser are not asserted here: happy-dom does not resolve layered `var()` shorthands.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import { NON_TEXT, type OklchColor } from '../tokens/runtime/contrast/index.ts';
import {
  borderContrast,
  borderControl,
  borderStrong,
  surfaceInset,
  translucentContrastOn,
} from './check-token-contrast-test-values.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Input } = await import('../components/input/input.svelte');
const { default: Textarea } = await import('../components/textarea/textarea.svelte');
const { default: Select } = await import('../components/select/select.svelte');

/** A stylesheet on one line per whitespace run, so a selector the formatter wrapped still matches. */
function flatten(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');
}

const inputCss = flatten('../components/input/input.css');
const textareaCss = flatten('../components/textarea/textarea.css');
const selectCss = flatten('../components/select/select.css');
const fieldChevronCss = flatten('./components/_field-chevron.css');

/** The density default selector: a field with no explicit outlined appearance in a comfortable subtree. */
function densityDefault(component: string): string {
  return `.${component}:where([data-density='comfortable'] *):not([data-cinder-appearance='outlined'])`;
}

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
];

/**
 * The declarations of the first rule that ends its selector list with `selector` (`selector {`),
 * or else the first rule where `selector` is a list member followed by a comma, or throws.
 */
function ruleBody(css: string, selector: string): string {
  let start = css.indexOf(`${selector} {`);
  if (start === -1) start = css.indexOf(`${selector},`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('Input appearance', () => {
  test('a field with no appearance carries no attribute, so its density decides', () => {
    const { container } = render(Input, { props: { id: 'plain', value: '', label: 'Name' } });
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.hasAttribute('data-cinder-appearance')).toBe(false);
  });

  test.each(['filled', 'outlined'] as const)('appearance=%s is set on the input', (appearance) => {
    const { container } = render(Input, {
      props: { id: `field-${appearance}`, value: '', label: 'Name', appearance },
    });
    expect(container.querySelector('input')?.getAttribute('data-cinder-appearance')).toBe(
      appearance,
    );
  });

  test('a grouped field marks the wrapper that draws its edge', () => {
    const filled = render(Input, {
      props: { id: 'grouped-filled', value: '', type: 'date', appearance: 'filled' },
    });
    expect(
      filled.container
        .querySelector('.cinder-input-group')
        ?.classList.contains('cinder-input-group--filled'),
    ).toBe(true);
    filled.unmount();

    const outlined = render(Input, {
      props: { id: 'grouped-outlined', value: '', type: 'date', appearance: 'outlined' },
    });
    expect(
      outlined.container
        .querySelector('.cinder-input-group')
        ?.classList.contains('cinder-input-group--outlined'),
    ).toBe(true);
    outlined.unmount();

    const unset = render(Input, { props: { id: 'grouped-unset', value: '', type: 'date' } });
    const group = unset.container.querySelector('.cinder-input-group');
    expect(group?.classList.contains('cinder-input-group--filled')).toBe(false);
    expect(group?.classList.contains('cinder-input-group--outlined')).toBe(false);
  });

  test('the filled rule is an inset fill and a 12px radius, with the edge left on the base rule', () => {
    const body = ruleBody(inputCss, densityDefault('cinder-input'));
    expect(body).toContain('background: var(--cinder-surface-inset);');
    expect(body).toContain('border-radius: var(--cinder-radius-lg);');
    expect(body).not.toContain('border-color');
    // The explicit selector shares the declarations with the density default.
    expect(inputCss).toContain(".cinder-input[data-cinder-appearance='filled'],");
    // The edge is still the 1px control border on the base rule, which is the 3:1 boundary.
    expect(ruleBody(inputCss, '.cinder-input')).toContain(
      'border: 1px solid var(--cinder-control-border);',
    );
  });

  test('the comfortable density makes a filled md field 48px by moving it to the lg step', () => {
    const body = ruleBody(inputCss, `${densityDefault('cinder-input')}[data-cinder-size='md']`);
    expect(body).toContain('--_cinder-input-height: var(--cinder-control-height-lg);');
  });

  test('focus lifts the fill under the shared 2px ring and keeps the transparent border', () => {
    const body = ruleBody(inputCss, ".cinder-input[data-cinder-appearance='filled']:focus-visible");
    expect(body).toContain('background: var(--cinder-control-background);');
    // The shared ring and its transparent border are unchanged.
    expect(ruleBody(inputCss, '.cinder-input:focus-visible')).toContain(
      'var(--_cinder-input-ring, var(--cinder-ring-color))',
    );
    expect(inputCss).toMatch(/\.cinder-input:focus-visible,[^{]*\{\s*border-color: transparent;/s);
  });

  test('hover, invalid and disabled keep their own edge and fill rules after the filled fill', () => {
    const filledAt = inputCss.indexOf(".cinder-input[data-cinder-appearance='filled'],");
    for (const selector of [
      '.cinder-input:hover:not(:disabled):not(:focus-visible)',
      ".cinder-input[aria-invalid='true']",
      '.cinder-input:disabled',
    ]) {
      expect(inputCss.indexOf(`${selector} {`), selector).toBeGreaterThan(filledAt);
    }
    expect(ruleBody(inputCss, '.cinder-input:disabled')).toContain(
      'background: var(--cinder-control-background-disabled);',
    );
    expect(ruleBody(inputCss, ".cinder-input[aria-invalid='true']")).toContain(
      'border-color: var(--cinder-control-border-invalid);',
    );
    expect(inputCss).toContain('border-color: var(--cinder-control-border-hover);');
  });

  test('a filled read-only value drops the fill and keeps the dashed edge', () => {
    const body = ruleBody(inputCss, `${densityDefault('cinder-input')}[readonly]:not(:disabled)`);
    expect(body).toContain('background: transparent;');
    expect(ruleBody(inputCss, '.cinder-input[readonly]:not(:disabled)')).toContain(
      'border-style: dashed;',
    );
  });

  test('a grouped filled field moves the fill and radius to the group, and the density default stays below the disabled rule', () => {
    expect(inputCss).toContain('.cinder-input-group--filled,');
    expect(inputCss).toContain(':where(:not(.cinder-input-group--outlined))');
    const body = ruleBody(inputCss, '.cinder-input-group--filled');
    expect(body).toContain('background: var(--cinder-surface-inset);');
    expect(body).toContain('border-radius: var(--cinder-radius-lg);');
    const groupFilledAt = inputCss.indexOf('.cinder-input-group--filled,');
    expect(inputCss.indexOf('.cinder-input-group--disabled {', groupFilledAt)).toBeGreaterThan(
      groupFilledAt,
    );
  });

  test('the bare title keeps its own radius so a hover tint is not drawn at 12px', () => {
    expect(ruleBody(inputCss, ".cinder-input[data-cinder-variant='bare']")).toContain(
      'border-radius: var(--cinder-control-radius);',
    );
  });
});

describe('Textarea appearance', () => {
  test('a field with no appearance carries no attribute', () => {
    const { container } = render(Textarea, { props: { id: 'notes', label: 'Notes' } });
    expect(container.querySelector('textarea')?.hasAttribute('data-cinder-appearance')).toBe(false);
  });

  test.each(['filled', 'outlined'] as const)(
    'appearance=%s is set on the textarea',
    (appearance) => {
      const { container } = render(Textarea, {
        props: { id: `notes-${appearance}`, label: 'Notes', appearance },
      });
      expect(container.querySelector('textarea')?.getAttribute('data-cinder-appearance')).toBe(
        appearance,
      );
    },
  );

  test('the filled rule is an inset fill and a 12px radius, and the edge stays the control border', () => {
    expect(textareaCss).toContain(".cinder-textarea[data-cinder-appearance='filled'],");
    const body = ruleBody(textareaCss, densityDefault('cinder-textarea'));
    expect(body).toContain('background: var(--cinder-surface-inset);');
    expect(body).toContain('border-radius: var(--cinder-radius-lg);');
    expect(ruleBody(textareaCss, '.cinder-textarea')).toContain(
      'border: 1px solid var(--cinder-control-border);',
    );
  });

  test('focus, disabled, invalid and read-only states are defined after the fill', () => {
    const filledAt = textareaCss.indexOf(".cinder-textarea[data-cinder-appearance='filled'],");
    expect(
      textareaCss.indexOf(".cinder-textarea[data-cinder-appearance='filled']:focus-visible,"),
    ).toBeGreaterThan(filledAt);
    for (const selector of [
      '.cinder-textarea:disabled',
      ".cinder-textarea[aria-invalid='true']",
      '.cinder-textarea[readonly]:not(:disabled)',
    ]) {
      expect(textareaCss.indexOf(`${selector} {`), selector).toBeGreaterThan(filledAt);
    }
    expect(
      ruleBody(textareaCss, `${densityDefault('cinder-textarea')}[readonly]:not(:disabled)`),
    ).toContain('background: transparent;');
  });
});

describe('Select appearance', () => {
  test('a default select carries no attribute, so its density decides', () => {
    const { container } = render(Select, {
      props: { id: 'plain', label: 'Agent', options },
    } as never);
    expect(container.querySelector('select')?.hasAttribute('data-cinder-appearance')).toBe(false);
  });

  test.each(['filled', 'outlined'] as const)(
    'appearance=%s is set on the native select',
    (appearance) => {
      const { container } = render(Select, {
        props: { id: `agent-${appearance}`, label: 'Agent', options, appearance },
      } as never);
      expect(container.querySelector('select')?.getAttribute('data-cinder-appearance')).toBe(
        appearance,
      );
    },
  );

  test('appearance=filled is set on the listbox trigger too', () => {
    const { container } = render(Select, {
      props: {
        id: 'agent-listbox',
        label: 'Agent',
        options,
        presentation: 'listbox',
        appearance: 'filled',
      },
    } as never);
    expect(
      container.querySelector('[role="combobox"]')?.getAttribute('data-cinder-appearance'),
    ).toBe('filled');
  });

  test('a ghost or inline select opts out of the density default, and only inline can ask for filled', () => {
    const expected = { ghost: 'outlined', inline: 'filled' } as const;
    for (const variant of ['ghost', 'inline'] as const) {
      const plain = render(Select, {
        props: { id: `plain-${variant}`, label: 'Agent', options, variant },
      } as never);
      expect(plain.container.querySelector('select')?.getAttribute('data-cinder-appearance')).toBe(
        'outlined',
      );
      plain.unmount();

      const asked = render(Select, {
        props: { id: `asked-${variant}`, label: 'Agent', options, variant, appearance: 'filled' },
      } as never);
      expect(asked.container.querySelector('select')?.getAttribute('data-cinder-appearance')).toBe(
        expected[variant],
      );
      asked.unmount();
    }
  });

  test('the filled rule is an inset fill and a 12px radius, with a 48px height in the comfortable density', () => {
    const fill = ruleBody(selectCss, densityDefault('cinder-select'));
    expect(fill).toContain('background-color: var(--cinder-surface-inset);');
    expect(fill).toContain('border-radius: var(--cinder-radius-lg);');
    expect(selectCss).toContain(".cinder-select[data-cinder-appearance='filled'],");
    const height = ruleBody(selectCss, `${densityDefault('cinder-select')}[data-cinder-size='md']`);
    expect(height).toContain('min-height: var(--cinder-control-height-lg);');
    expect(ruleBody(selectCss, '.cinder-select')).toContain(
      'border: 1px solid var(--cinder-control-border);',
    );
  });

  test('focus, disabled, inert, invalid and read-only states are defined after the fill', () => {
    const filledAt = selectCss.indexOf(".cinder-select[data-cinder-appearance='filled'],");
    for (const selector of [
      ".cinder-select[data-cinder-appearance='filled']:focus-visible,",
      '.cinder-select:disabled',
      ".cinder-select[aria-disabled='true']",
      ".cinder-select[aria-invalid='true']",
      ".cinder-select[aria-readonly='true']:not(:disabled):not([aria-disabled='true'])",
    ]) {
      expect(
        selectCss.indexOf(selector.endsWith(',') ? selector : `${selector} {`),
        selector,
      ).toBeGreaterThan(filledAt);
    }
  });
});

describe('Select chevron and inline variant', () => {
  test('the native select never shows the browser caret and reserves 40px for the chevron', () => {
    const body = ruleBody(selectCss, '.cinder-select');
    expect(body).toContain('appearance: none;');
    expect(body).toContain('padding-inline: var(--cinder-space-3) var(--cinder-space-10);');
    const chevron = ruleBody(fieldChevronCss, '.cinder-_field-chevron');
    expect(chevron).toContain('inset-inline-end: var(--cinder-space-3);');
    expect(chevron).toContain('inline-size: 1.125rem;');
    expect(chevron).toContain('block-size: 1.125rem;');
    expect(chevron).toContain('mask-size: 1.125rem 1.125rem;');
  });

  test('Input and Select default to the md height', () => {
    expect(ruleBody(inputCss, '.cinder-input')).toContain(
      '--_cinder-input-height: var(--cinder-control-height-md);',
    );
    expect(ruleBody(selectCss, '.cinder-select')).toContain(
      'min-height: var(--cinder-control-height-md);',
    );
    const { container } = render(Select, {
      props: { id: 'sized', label: 'Agent', options },
    } as never);
    expect(container.querySelector('select')?.getAttribute('data-cinder-size')).toBe('md');
  });

  test('an inline select takes the surrounding type, the sm height and an auto width', () => {
    const { container } = render(Select, {
      props: { id: 'inline', label: 'Sender', labelVisible: false, options, variant: 'inline' },
    } as never);
    expect(container.querySelector('select')?.getAttribute('data-cinder-variant')).toBe('inline');
    expect(
      container.querySelector('.cinder-select-field')?.getAttribute('data-cinder-variant'),
    ).toBe('inline');

    const body = ruleBody(selectCss, ".cinder-select[data-cinder-variant='inline']");
    expect(body).toContain('font-size: inherit;');
    expect(body).toContain('font-weight: inherit;');
    expect(body).toContain('font-family: inherit;');
    expect(body).toContain('min-height: var(--cinder-control-height-sm);');
    expect(body).toContain('inline-size: auto;');
    expect(ruleBody(selectCss, ".cinder-select-field[data-cinder-variant='inline']")).toContain(
      'display: inline-flex;',
    );
  });
});

describe('Filled edge contrast (WCAG 1.4.11)', () => {
  // The filled field paints the edge over its own inset fill. At rest the edge is the quiet control
  // tier (owner decision, 2026-11-11), which only has to stay heavier than a container's edge on
  // that fill; under `prefers-contrast: more` it is the contrast tier, which has to clear 3:1
  // against the fill as well as against the surface around it. Dark mode's contrast tier is opaque.
  test('the resting control edge is heavier than a container edge on the inset fill', () => {
    for (const arm of ['light', 'dark'] as const) {
      expect(translucentContrastOn(borderControl[arm], surfaceInset[arm])).toBeGreaterThan(
        translucentContrastOn(borderStrong[arm], surfaceInset[arm]),
      );
    }
  });

  test('the contrast tier clears 3:1 against the default light and dark inset fill', () => {
    for (const arm of ['light', 'dark'] as const) {
      expect(translucentContrastOn(borderContrast[arm], surfaceInset[arm])).toBeGreaterThanOrEqual(
        NON_TEXT,
      );
    }
  });

  test("the contrast tier clears 3:1 against the comfortable density's deeper light inset fill", () => {
    // foundation.css: `--cinder-surface-inset: light-dark(oklch(92.5% 0.005 265), ...)`.
    const comfortableInset: OklchColor = { l: 0.925, c: 0.005, h: 265 };
    expect(translucentContrastOn(borderContrast.light, comfortableInset)).toBeGreaterThanOrEqual(
      NON_TEXT,
    );
    const foundation = readFileSync(new URL('./foundation.css', import.meta.url), 'utf8');
    expect(foundation).toContain(
      '--cinder-surface-inset: light-dark(oklch(92.5% 0.005 265), oklch(21% 0.012 265));',
    );
  });
});
