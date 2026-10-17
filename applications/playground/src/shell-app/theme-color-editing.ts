/**
 * The pure rules of the color editor (COR-263): which edit route a color token has, what the
 * draft holds for it in each color mode, how the visual picker and the numeric controls map
 * onto the same authored value, and which background a role renders on.
 *
 * Source preservation is the rule throughout. The picker works in sRGB, so it edits an
 * authored color directly only when that color is an in-gamut sRGB or OKLCH value; anything
 * else (Display P3, other spaces, out-of-gamut values) is previewed through an explicit
 * conversion and changes only when the user chooses to edit through the picker.
 */

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import {
  authoredOklch,
  authoredText,
  convertTo,
  gamutInfo,
  oklchColor,
  oklchText,
  parseColorText,
  readDtcgColor,
  type DtcgColor,
} from './theme-color-model.ts';
import type { JsonObject, JsonValue, OverrideScope, ThemeEnvelope } from './theme-draft-types.ts';
import { getNode } from './theme-override-tree.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { literalValueOf, overrideValue, sourcePathOf } from './theme-token-edit.ts';

/** How a color token is edited; every public color record has exactly one route. */
export type ColorEditRoute =
  /** The authored literal is edited in place. */
  | 'typed-literal'
  /** The token is an alias: it stays linked until the user explicitly detaches it. */
  | 'alias-detach'
  /** A trusted CSS recipe governs the CSS; the literal replaces it explicitly. */
  | 'recipe-replace'
  /** The CSS value has no DTCG form and is edited as plain CSS. */
  | 'css-only';

export function colorEditRoute(row: CatalogueRow): ColorEditRoute {
  if (row.edit === 'css-only') return 'css-only';
  if (row.aliases.length > 0) return 'alias-detach';
  return row.edit === 'recipe' ? 'recipe-replace' : 'typed-literal';
}

/** The value the draft holds for a token at one scope, or what it resolves to there. */
export function committedColor(
  row: CatalogueRow,
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
): DtcgColor | null {
  const overridden = scope === null ? undefined : overrideValue(envelope, scope, row.path);
  return readDtcgColor(overridden) ?? readDtcgColor(literalValueOf(envelope, context, row.path));
}

export type ModeColors = { light: DtcgColor | null; dark: DtcgColor | null };

/** Light and dark side by side. Reading one mode never touches the other mode's draft. */
export function colorsByMode(envelope: ThemeEnvelope, path: string): ModeColors {
  const read = (colorMode: 'light' | 'dark') =>
    readDtcgColor(literalValueOf(envelope, { colorMode, motion: 'default' }, path));
  return { light: read('light'), dark: read('dark') };
}

export type PickerBinding =
  /** The picker edits the authored value; its output is written in `writeSpace`. */
  | { direct: true; value: string; writeSpace: 'srgb' | 'oklch' }
  /** The picker only previews; `reason` says why editing through it needs an explicit choice. */
  | { direct: false; value: string; reason: string };

const PICKER_SPACES = new Set(['srgb', 'oklch']);

/** The picker's value for an authored color, and whether it may edit that color directly. */
export function pickerBinding(color: DtcgColor): PickerBinding {
  const value = oklchText(authoredOklch(color));
  if (!PICKER_SPACES.has(color.colorSpace)) {
    return {
      direct: false,
      value,
      reason: `This color is authored in ${color.colorSpace}. The picker shows an OKLCH preview and leaves the source unchanged.`,
    };
  }
  if (!gamutInfo(color).srgb) {
    return {
      direct: false,
      value,
      reason:
        'This color is outside sRGB. The picker shows an sRGB-mapped preview and leaves the source unchanged.',
    };
  }
  return { direct: true, value, writeSpace: color.colorSpace === 'srgb' ? 'srgb' : 'oklch' };
}

/**
 * The authored value after a picker edit. The picked color keeps its own alpha and is written
 * in the space the picker edits directly (sRGB stays sRGB, OKLCH stays OKLCH), or in OKLCH
 * when the user explicitly chose to edit through the picker.
 */
export function colorFromPicker(picked: string, writeSpace: 'srgb' | 'oklch'): DtcgColor | null {
  const parsed = parseColorText(picked);
  if (!parsed.ok) return null;
  if (writeSpace === 'oklch') return oklchColor(authoredOklch(parsed.color));
  return convertTo(parsed.color, 'srgb');
}

/** The text field's value: the authored color in its own space. */
export const colorFieldText = authoredText;

/** The path→document location of a token's source node in the embedded base, if any. */
function baseNode(envelope: ThemeEnvelope, path: string): JsonObject | undefined {
  const sourcePath = sourcePathOf(envelope, path);
  for (const document of Object.values(envelope.base.documents)) {
    const node = getNode(document as JsonObject, sourcePath);
    if (typeof node === 'object' && node !== null && !Array.isArray(node)) return node;
  }
  return undefined;
}

export type AlphaStep = { path: string; alpha: number };

const ALPHA_STEP =
  /^color-mix\(\s*in oklch,\s*var\(\s*(--[\w-]+)\s*\),\s*transparent\s+([\d.]+)%\s*\)$/;

function cinderExtension(node: JsonObject): JsonObject | undefined {
  const extensions = node['$extensions'];
  const cinder =
    typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)
      ? extensions['com.lostgradient.cinder']
      : undefined;
  return typeof cinder === 'object' && cinder !== null && !Array.isArray(cinder)
    ? cinder
    : undefined;
}

/**
 * The tokens composed as alpha steps over `path` -- `color-mix(in oklch, var(<its property>),
 * transparent N%)` -- lightest first. For `border.ink` that is the five border tiers, which is
 * what lets its editor preview every tier the ink drives instead of only the ink itself.
 */
export function alphaStepsOf(envelope: ThemeEnvelope, path: string): AlphaStep[] {
  const source = baseNode(envelope, path);
  const property = source === undefined ? undefined : cinderExtension(source)?.['cssProperty'];
  if (typeof property !== 'string') return [];
  const steps = new Map<string, number>();
  const visit = (node: JsonValue, segments: string[]): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    if ('$value' in node) {
      const recipe = cinderExtension(node)?.['cssRecipe'];
      const match = typeof recipe === 'string' ? ALPHA_STEP.exec(recipe.trim()) : null;
      if (match && match[1] === property) {
        steps.set(
          segments.filter((segment) => segment !== '$root').join('.'),
          (100 - Number(match[2])) / 100,
        );
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') && key !== '$root') continue;
      visit(child, [...segments, key]);
    }
  };
  for (const document of Object.values(envelope.base.documents)) visit(document, []);
  return [...steps]
    .map(([stepPath, alpha]) => ({ path: stepPath, alpha }))
    .toSorted((left, right) => left.alpha - right.alpha);
}

const BACKGROUND_PATH = /^(surface|fill|overlay)\.|\.background$/;

/** `contrastPairs` declared on the token's source node. */
export function contrastPairsOf(envelope: ThemeEnvelope, path: string): string[] {
  const extensions = baseNode(envelope, path)?.['$extensions'];
  const cinder =
    typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)
      ? extensions['com.lostgradient.cinder']
      : undefined;
  const pairs =
    typeof cinder === 'object' && cinder !== null && !Array.isArray(cinder)
      ? cinder['contrastPairs']
      : undefined;
  return Array.isArray(pairs)
    ? pairs.filter((pair): pair is string => typeof pair === 'string')
    : [];
}

export type EffectiveBackground = { path: string; color: DtcgColor; derived: 'paired' | 'page' };

/**
 * The surface a role renders on. A foreground role uses the surface its contrast pairs name;
 * a surface role, or one with no paired surface, renders over the page surface.
 */
export function effectiveBackground(
  row: CatalogueRow,
  envelope: ThemeEnvelope,
  context: ThemePreviewContext,
): EffectiveBackground | null {
  const paired = contrastPairsOf(envelope, row.path).find(
    (pair) => BACKGROUND_PATH.test(pair) && pair !== row.path,
  );
  const isBackground = BACKGROUND_PATH.test(row.path);
  const path = !isBackground && paired !== undefined ? paired : 'surface.base';
  const color = readDtcgColor(literalValueOf(envelope, context, path));
  if (color === null) return null;
  return { path, color, derived: !isBackground && paired !== undefined ? 'paired' : 'page' };
}

/** The value text an alias shows: where it points, never silently resolved away. */
export function aliasTargets(row: CatalogueRow, value: JsonValue | undefined): string[] {
  if (typeof value === 'string' && /^\{[^{}]+\}$/.test(value)) return [value.slice(1, -1)];
  return [...row.aliases];
}
