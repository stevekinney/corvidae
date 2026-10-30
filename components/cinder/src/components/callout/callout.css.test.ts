/**
 * Callout's soft-surface wiring, asserted against the CSS source with `postcss` (the same
 * parser-based approach as `src/test/focus-ring-recipe.test.ts` — happy-dom does not compute
 * styles from stylesheets, and the package ships no browser-test harness).
 *
 * A Callout is a tint and an icon inside one edge (COR-1821): there is no accent stripe. The base
 * rule sets one box border and one radius, the soft `border-color` algebra lives in the shared
 * `_status-surface.css` partial, and each variant rule only sets the partial's per-variant inputs
 * (`--_cinder-status-base` + the foreground chroma). A variant rule may carry NO border-affecting
 * declaration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { parse, type AtRule, type Declaration, type Rule } from 'postcss';

function loadCss(relativePath: string): string {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFileSync(fullPath, 'utf8');
}

const calloutCss = loadCss('./callout.css');
const root = parse(calloutCss);

// The soft-surface color algebra (border) lives in the shared `_status-surface.css` partial,
// consumed by Callout via the `.cinder-_status-surface*` classes. Callout's variant rules only set
// the partial's per-variant inputs.
const statusSurfaceCss = loadCss('../../styles/components/_status-surface.css');
const statusSurfaceRoot = parse(statusSurfaceCss);

function findRuleIn(parsedRoot: ReturnType<typeof parse>, selector: string): Rule {
  let match: Rule | undefined;
  parsedRoot.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      match = rule;
      return false;
    }
    return undefined;
  });
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match;
}

/**
 * The fixed soft-border chroma in the partial (uniform across variants). Since COR-1552 the soft
 * border is painted in the surface's own background so it draws no visible outline, which makes
 * its chroma the surface's.
 */
const SOFT_BORDER_CHROMA = { light: 0.026, dark: 0.03 };

/**
 * Every property that can paint or size a border edge — shorthands, longhands,
 * physical sides, logical sides, and the `border-image` family (which can draw
 * a directional stripe without touching `border-color`/`border-width` at all).
 * A variant rule may carry NONE of these; the soft border color lives in the shared
 * partial, so any border-affecting declaration appearing on a variant rule is an
 * escape hatch the tests must reject.
 */
const BORDER_AFFECTING = new Set([
  'border',
  'border-width',
  'border-color',
  'border-style',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-inline',
  'border-inline-start',
  'border-inline-end',
  'border-inline-width',
  'border-inline-color',
  'border-inline-start-width',
  'border-inline-end-width',
  'border-inline-start-color',
  'border-inline-end-color',
  'border-block',
  'border-block-start',
  'border-block-end',
  'border-block-width',
  'border-block-color',
  'border-block-start-width',
  'border-block-end-width',
  'border-block-start-color',
  'border-block-end-color',
  'border-image',
  'border-image-source',
  'border-image-slice',
  'border-image-width',
  'border-image-outset',
  'border-image-repeat',
]);

/**
 * Find the single non-`@media` rule for a selector. The forced-colors block
 * reuses `.cinder-callout`, so skipping `atrule` parents keeps us on the base
 * rule whose cascade the acceptance criteria reference.
 */
/**
 * A rule is "effectively top-level" when the only at-rules between it and the
 * stylesheet root are `@layer` wrappers. Component CSS now self-declares
 * `@layer cinder.components { … }`, so the base rules sit one `@layer` deep;
 * that wrapper is transparent for cascade purposes. Rules nested under
 * `@media` / `@supports` / `@container` (e.g. the forced-colors block) are NOT
 * top-level and must still be skipped.
 */
function isEffectivelyTopLevel(rule: Rule): boolean {
  let ancestor = rule.parent;
  while (ancestor && ancestor.type !== 'root') {
    if (ancestor.type === 'atrule' && (ancestor as AtRule).name !== 'layer') return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function findRule(selector: string): Rule {
  let match: Rule | undefined;
  root.walkRules((rule) => {
    if (!isEffectivelyTopLevel(rule)) return undefined;
    if (rule.selectors.includes(selector)) {
      match = rule;
      return false;
    }
    return undefined;
  });
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match;
}

function declValue(rule: Rule, property: string): string | undefined {
  let value: string | undefined;
  rule.walkDecls(property, (decl) => {
    value = decl.value;
  });
  return value;
}

function borderProps(rule: Rule): string[] {
  return rule.nodes
    .filter((node): node is Declaration => node.type === 'decl')
    .map((decl) => decl.prop)
    .filter((prop) => BORDER_AFFECTING.has(prop));
}

/**
 * Pull the chroma (C) out of an `oklch(from var(--token) L C h)` color. Only
 * this exact relative-color form is accepted — a literal `oklch(L C h)` or a
 * differently shaped value returns NaN, so a malformed stripe color fails the
 * comparison cleanly instead of silently matching.
 */
function oklchChroma(arm: string): number {
  const match = /oklch\(\s*from\s+var\([^)]+\)\s+[\d.%]+\s+([\d.]+)\s+h\s*\)/.exec(arm);
  return match ? Number(match[1]) : Number.NaN;
}

/** Split a `light-dark(a, b)` value into its two arms on the top-level comma. */
function lightDarkArms(value: string): [string, string] {
  const match = /^light-dark\(([\s\S]+)\)$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`expected light-dark(), got: ${value}`);
  const inner = match[1];
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      return [inner.slice(0, index).trim(), inner.slice(index + 1).trim()];
    }
  }
  throw new Error(`light-dark() missing comma separator: ${value}`);
}

const VARIANTS: Array<{ variant: string; token: string }> = [
  { variant: 'info', token: '--cinder-status-info-solid' },
  { variant: 'success', token: '--cinder-status-success-solid' },
  { variant: 'warning', token: '--cinder-status-warning-solid' },
  { variant: 'danger', token: '--cinder-status-danger-solid' },
];

describe('callout — one edge, no stripe', () => {
  test('base rule sets one box border and one radius on every corner', () => {
    const base = findRule('.cinder-callout');
    expect(declValue(base, 'border')).toBe('1px solid var(--cinder-border)');
    expect(declValue(base, 'border-radius')).toBe('var(--cinder-radius-md)');
    expect(borderProps(base)).toEqual(['border']);
    for (const property of ['border-start-start-radius', 'border-end-start-radius']) {
      expect(declValue(base, property)).toBeUndefined();
    }
  });

  for (const { variant, token } of VARIANTS) {
    describe(`variant: ${variant}`, () => {
      const rule = findRule(`.cinder-callout[data-cinder-variant='${variant}']`);

      test('carries no border declarations — the algebra lives in the shared partial', () => {
        // A variant rule must NOT reintroduce any border-affecting declaration (shorthand or
        // longhand): doing so would lift one edge above the others and bring the stripe back.
        expect(borderProps(rule)).toEqual([]);
      });

      test('sets the status base color to the matching status token', () => {
        expect(declValue(rule, '--_cinder-status-base')).toBe(`var(${token})`);
      });

      test('sets no stripe chroma input', () => {
        expect(declValue(rule, '--_cinder-status-stripe-chroma')).toBeUndefined();
      });

      test('sets both foreground chroma inputs (light + dark)', () => {
        expect(Number(declValue(rule, '--_cinder-status-fg-chroma-light'))).not.toBeNaN();
        expect(Number(declValue(rule, '--_cinder-status-fg-chroma-dark'))).not.toBeNaN();
      });
    });
  }

  describe('shared _status-surface partial', () => {
    // The recipe selectors are self-doubled (`.x.x`) to reach specificity (0,2,0)
    // — see the partial's header and the specificity test below.
    const borderRule = findRuleIn(
      statusSurfaceRoot,
      '.cinder-_status-surface-border.cinder-_status-surface-border',
    );

    test('recipe selectors are self-doubled for (0,2,0) specificity over the component base', () => {
      // The component base (`.cinder-callout`, etc.) sets `background`/`border` at
      // (0,1,0). The recipe must win regardless of import order (sidecar mode loads
      // the base AFTER the recipe), so each recipe selector doubles its class to
      // (0,2,0) — matching the pre-extraction variant-selector specificity. A
      // single-class selector here would regress to a source-order tie.
      const selectors: string[] = [];
      statusSurfaceRoot.walkRules((rule) => {
        for (const selector of rule.selectors) {
          if (/cinder-_status-surface/.test(selector)) selectors.push(selector);
        }
      });
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        // Each must repeat its single class (e.g. `.x.x`) — reject a bare `.x`.
        const match = /^(\.cinder-_status-surface[a-z-]*)\1$/.exec(selector);
        expect(match, `selector "${selector}" must be self-doubled for (0,2,0)`).not.toBeNull();
      }
    });

    test('soft border derives from --_cinder-status-base', () => {
      const border = declValue(borderRule, 'border-color');
      expect(border).toBeDefined();
      const basePattern = /oklch\(\s*from\s+var\(--_cinder-status-base\)/;
      const [light, dark] = lightDarkArms(border!);
      expect(light).toMatch(basePattern);
      expect(dark).toMatch(basePattern);
    });

    test('soft border uses the surface background chroma values, so it draws no outline', () => {
      const border = declValue(borderRule, 'border-color');
      const [light, dark] = lightDarkArms(border!);
      expect(oklchChroma(light)).toBe(SOFT_BORDER_CHROMA.light);
      expect(oklchChroma(dark)).toBe(SOFT_BORDER_CHROMA.dark);
    });
  });
});
