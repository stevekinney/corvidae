/**
 * COR-2310: the comfortable density, the third step of the one density axis (compact, default,
 * comfortable).
 *
 * `data-density="comfortable"` retunes type, control heights, radii and padding, and (COR-2308's
 * owner decision) switches the light arm of the surface ladder to the consumer ladder. Dark mode
 * is the same in every density, so the comfortable rule repeats the shipped dark values; this file
 * holds those copies in step with `tokens-base.css` and checks the consumer ladder's text contrast.
 * These pin the CSS shape and the color math; `density.playwright.ts` checks computed values on a
 * Button, a Card and a PageHeader in a browser.
 *
 * Consumer-ladder ratios at the time of writing (WCAG, light arm):
 *
 * | Foreground            | Canvas 95.5% | Surface 100% | Inset 92.5% |
 * | --------------------- | ------------ | ------------ | ----------- |
 * | muted, 42% 0.01 265   | 7.42:1       | 8.46:1       | 6.78:1      |
 * | subtle, 50% 0.01 265  | 5.26:1       | 6.00:1       | 4.81:1      |
 */
import { describe, expect, test } from 'bun:test';

import {
  AA_TEXT,
  contrastRatio,
  wcagLuminance,
  type OklchColor,
} from '../tokens/runtime/contrast/index.ts';

const foundation = await Bun.file(new URL('./foundation.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('./tokens-base.css', import.meta.url)).text();
const cardCss = await Bun.file(new URL('../components/card/card.css', import.meta.url)).text();

const COMFORTABLE_SELECTOR = ":where([data-density='comfortable'])";

/** The body of the brace block that opens at `open`. */
function blockAt(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('unterminated block');
}

/** The top-level comfortable rule (not the one nested in the coarse-pointer block). */
function comfortableBlock(): string {
  const start = foundation.indexOf(`\n${COMFORTABLE_SELECTOR} {`);
  expect(start, 'foundation.css has a top-level comfortable rule').toBeGreaterThan(-1);
  expect(foundation.indexOf(`\n${COMFORTABLE_SELECTOR} {`, start + 1), 'only one').toBe(-1);
  return blockAt(foundation, foundation.indexOf('{', start));
}

/** The comfortable rule nested in the one `@media (pointer: coarse)` block. */
function coarseComfortableBlock(): string {
  const media = foundation.indexOf('@media (pointer: coarse)');
  expect(media, 'foundation.css has a (pointer: coarse) block').toBeGreaterThan(-1);
  const coarse = blockAt(foundation, foundation.indexOf('{', media));
  const start = coarse.indexOf(`${COMFORTABLE_SELECTOR} {`);
  expect(start, 'the coarse block adjusts the comfortable density').toBeGreaterThan(-1);
  return blockAt(coarse, coarse.indexOf('{', start));
}

/** The `[data-theme='dark']` override block of tokens-base.css. */
function darkThemeBlock(): string {
  const start = tokens.indexOf("\n[data-theme='dark'] {");
  expect(start, "tokens-base.css has a [data-theme='dark'] block").toBeGreaterThan(-1);
  return blockAt(tokens, tokens.indexOf('{', start));
}

/** One declaration's value inside a block, whitespace collapsed. */
function declaration(block: string, property: string): string {
  const match = new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`).exec(block);
  if (!match?.[1]) throw new Error(`${property} is not declared in the block`);
  return match[1].replace(/\s+/g, ' ').trim();
}

/** `oklch(L% C H)` as a color the contrast helpers take. */
function parseOklch(value: string): OklchColor {
  const match = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(value.trim());
  if (!match) throw new Error(`not a literal oklch(): ${value}`);
  return { l: Number(match[1]) / 100, c: Number(match[2]), h: Number(match[3]) };
}

/** Both arms of a `light-dark(oklch(...), oklch(...))` declaration. */
function arms(block: string, property: string): { light: string; dark: string } {
  const match = /^light-dark\((oklch\([^)]*\)), (oklch\([^)]*\))\)$/.exec(
    declaration(block, property),
  );
  if (!match?.[1] || !match[2]) throw new Error(`${property} is not a two-arm light-dark()`);
  return { light: match[1], dark: match[2] };
}

const LADDER = [
  '--cinder-surface-canvas',
  '--cinder-surface',
  '--cinder-surface-inset',
  '--cinder-text-muted',
  '--cinder-text-subtle',
] as const;

describe('COR-2310: the comfortable density', () => {
  test('retunes type to 15px body, 14px secondary, an 18px section title and a 28px page title', () => {
    const block = comfortableBlock();
    expect(declaration(block, '--cinder-text-body')).toBe('0.9375rem');
    expect(declaration(block, '--cinder-text-secondary')).toBe('0.875rem');
    expect(declaration(block, '--cinder-text-section-title')).toBe('1.125rem');
    expect(declaration(block, '--cinder-text-page-title')).toBe(
      'var(--cinder-text-page-title-large)',
    );
    expect(tokens).toContain('--cinder-text-page-title-large: 1.75rem;');
  });

  test('controls are 32, 40 and 48px, and Button follows through its redeclared aliases', () => {
    const block = comfortableBlock();
    expect(declaration(block, '--cinder-control-height-sm')).toBe('2rem');
    expect(declaration(block, '--cinder-control-height-md')).toBe('2.5rem');
    expect(declaration(block, '--cinder-control-height-lg')).toBe('3rem');
    for (const step of ['sm', 'md', 'lg']) {
      expect(declaration(block, `--cinder-button-height-${step}`)).toBe(
        `var(--cinder-control-height-${step})`,
      );
    }
  });

  test('surfaces round to 16px and fields to 10px, while a Button stays a pill', () => {
    const block = comfortableBlock();
    expect(declaration(block, '--cinder-radius-surface')).toBe('1rem');
    expect(declaration(block, '--cinder-radius-control')).toBe('0.625rem');
    expect(declaration(block, '--cinder-control-radius')).toBe('var(--cinder-radius-control)');
    // COR-2312: a Button is a pill at every density, so comfortable never redeclares its radii.
    expect(block).not.toContain('--cinder-button-radius');
    expect(cardCss).toContain('border-radius: var(--cinder-radius-surface);');
  });

  test('cards pad at space-5 and stacks gap at space-4', () => {
    const block = comfortableBlock();
    expect(declaration(block, '--cinder-density-pad-card')).toBe('var(--cinder-space-5)');
    expect(declaration(block, '--cinder-pad-card')).toBe('var(--cinder-space-5)');
    expect(declaration(block, '--cinder-gap-stack')).toBe('var(--cinder-space-4)');
    expect(cardCss).toContain('padding: var(--cinder-density-pad-card);');
  });

  test('a coarse pointer reads at 16px and keeps the 44px touch target', () => {
    const block = coarseComfortableBlock();
    expect(declaration(block, '--cinder-text-body')).toBe('1rem');
    expect(declaration(block, '--cinder-control-height-sm')).toBe('var(--cinder-touch-target-min)');
    expect(declaration(block, '--cinder-control-height-md')).toBe('var(--cinder-touch-target-min)');
  });

  test('the coarse-pointer adjustment comes after the comfortable rule, so it wins', () => {
    expect(foundation.indexOf(`\n${COMFORTABLE_SELECTOR} {`)).toBeLessThan(
      foundation.indexOf('@media (pointer: coarse)'),
    );
  });

  test('compact still remaps its four tokens', () => {
    const start = foundation.indexOf(":where([data-density='compact']) {");
    expect(start).toBeGreaterThan(-1);
    const block = blockAt(foundation, foundation.indexOf('{', start));
    expect(declaration(block, '--cinder-density-row-height')).toBe('2.5rem');
    expect(declaration(block, '--cinder-density-pad-card')).toBe('var(--cinder-space-3)');
  });
});

describe('COR-2310 and COR-2308: comfortable switches the light ladder only', () => {
  test('the light arm is the consumer ladder', () => {
    const block = comfortableBlock();
    expect(arms(block, '--cinder-surface-canvas').light).toBe('oklch(95.5% 0.004 265)');
    expect(arms(block, '--cinder-surface').light).toBe('oklch(100% 0 255)');
    expect(arms(block, '--cinder-surface-inset').light).toBe('oklch(92.5% 0.005 265)');
    expect(arms(block, '--cinder-text-muted').light).toBe('oklch(42% 0.01 265)');
    expect(arms(block, '--cinder-text-subtle').light).toBe('oklch(50% 0.01 265)');
    // Raised is already pure white in the default ladder, so comfortable leaves it alone.
    expect(block).not.toContain('--cinder-surface-raised:');
  });

  for (const property of LADDER) {
    test(`${property} keeps the shipped dark value in every density`, () => {
      expect(arms(comfortableBlock(), property).dark).toBe(declaration(darkThemeBlock(), property));
    });
  }

  test('muted and subtle text clear AA on every consumer-ladder surface', () => {
    const block = comfortableBlock();
    const grounds = {
      canvas: parseOklch(arms(block, '--cinder-surface-canvas').light),
      surface: parseOklch(arms(block, '--cinder-surface').light),
      inset: parseOklch(arms(block, '--cinder-surface-inset').light),
    };
    for (const foreground of ['--cinder-text-muted', '--cinder-text-subtle'] as const) {
      const ink = parseOklch(arms(block, foreground).light);
      for (const [groundName, ground] of Object.entries(grounds)) {
        expect(
          contrastRatio(wcagLuminance(ink), wcagLuminance(ground)),
          `${foreground} on the comfortable ${groundName}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
});
