/**
 * Converts Cinder's resolved token contexts (`src/tokens/resolved/{light,dark}.json`) into the
 * Design System type's `tokens.json` (list-shaped families of at most 60 tokens, names without the
 * leading `--`, OKLCH colour strings) and a `tokens.css` wrapped in the lowest cascade layer, so
 * Cinder's own stylesheet stays the source of truth in previews.
 */

import type { ComponentManifest } from './manifest.ts';
import { sourcePaths } from './paths.ts';

/** One entry of a resolved token context. */
export type ResolvedToken = {
  $type: string;
  $value: unknown;
  $description?: string;
  $extensions: {
    'com.lostgradient.cinder': { cssProperty: string; category: string; cssRecipe?: string | null };
  };
};

/** A resolved token context, keyed by dotted token path. */
export type ResolvedContext = Record<string, ResolvedToken>;

/** A token whose value is the same in both themes. */
export type PlainToken = { name: string; usage: string; value: string };
/** A colour or shadow token, which carries one value per theme. */
export type ThemedToken = { name: string; usage: string; value: { light: string; dark: string } };

/** One type style in the `type` section. */
export type TypeStyle = {
  name: string;
  fontSize: string;
  lineHeight: number;
  fontWeight: number;
  usage: string;
  family?: string;
  sample?: string;
};

/** The non-colour token families, in the order `tokens.json` and `tokens.css` list them. */
export const FAMILY_NAMES = [
  'spacing',
  'radius',
  'shadow',
  'size',
  'zIndex',
  'opacity',
  'duration',
  'easing',
  'typeMetrics',
  'componentSpacing',
  'componentSizing',
] as const;

/** A non-colour token family. */
export type FamilyName = (typeof FAMILY_NAMES)[number];

/** The most tokens one family may hold. */
export const FAMILY_TOKEN_CAP = 60;

const FAMILY_NOTES: Record<FamilyName, string> = {
  spacing:
    'The rem spacing scale and its semantic aliases (pad, gap, density). Use these for padding, gap and margin.',
  radius: 'Corner radii and the control and surface aliases.',
  shadow: 'Elevation shadows, tuned separately for each theme.',
  size: 'Control heights, touch target, content widths, focus ring and other fixed sizes.',
  zIndex: 'Stacking layers for overlays.',
  opacity: 'Opacity steps for disabled and muted content.',
  duration:
    'Motion durations before the reduced-motion context applies; reduced motion sets these to 0ms.',
  easing: 'Easing curves for motion.',
  typeMetrics:
    'Font sizes, weights, line heights, letter spacing and type-role sizes as named tokens.',
  componentSpacing:
    'Spacing owned by individual components. Override these to retune one component.',
  componentSizing: 'Sizes, radii, type and timing owned by individual components.',
};

/**
 * Token namespaces that are system-wide rather than owned by one component. Every other namespace
 * in `package.tokenNamespaces`, and every component id, routes to the component families.
 */
const SYSTEM_NAMESPACES = new Set([
  'accent',
  'border',
  'content',
  'control',
  'density',
  'ease',
  'fill',
  'font',
  'gap',
  'leading',
  'list',
  'motion',
  'opacity',
  'overlay',
  'pad',
  'polarity',
  'radius',
  'ring',
  'scrollbar',
  'severity',
  'shadow',
  'space',
  'status',
  'surface',
  'text',
  'touch',
  'tracking',
  'type',
  'type-role',
  'z',
  'checker',
  'chart',
  'skeleton',
  'modal',
  'toggle',
]);

const CATEGORY_FAMILIES: Record<string, FamilyName> = {
  spacing: 'spacing',
  radius: 'radius',
  size: 'size',
  layout: 'size',
  'z-index': 'zIndex',
  opacity: 'opacity',
  typography: 'typeMetrics',
};

const ROLE_WEIGHTS: Record<string, number> = { 'page-title': 600, 'section-title': 600 };

const ROLE_SAMPLES: Record<string, string> = {
  'page-title': 'Workers',
  'section-title': 'Recent runs',
  body: 'Cinder is the component library behind Interborough.',
  secondary: 'Updated 4 minutes ago',
  code: 'bun run --filter=@lostgradient/cinder tokens:check',
};

function lookup<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Formats a number the way the original generator did: four decimals, rounded half to even on
 * exact ties, trailing zeros and a bare point dropped, and negative zero written as `0`.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot format ${value}`);
  let fixed = value.toFixed(4);
  // toFixed rounds an exact tie away from zero; a tie can only be a dyadic fraction, whose
  // 30-digit expansion is exact, so it is detectable here and rounded to even instead.
  const exact = Math.abs(value).toFixed(30);
  const point = exact.indexOf('.');
  if (exact[point + 5] === '5' && /^0*$/.test(exact.slice(point + 6))) {
    const truncated = exact.slice(0, point + 5);
    const lastDigit = Number(truncated.at(-1));
    if (lastDigit % 2 === 0) fixed = (value < 0 ? '-' : '') + truncated;
  }
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

function numeric(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} is not a number: ${String(value)}`);
  return value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** Formats a DTCG colour value as an `oklch()` or `rgb()` string. */
export function formatColor(input: unknown): string {
  const color = asRecord(input, 'colour');
  const components = color['components'];
  if (!Array.isArray(components)) throw new Error('colour has no components');
  const parts = components.map((component, index) => numeric(component, `component ${index}`));
  const alpha = color['alpha'] === undefined ? 1 : numeric(color['alpha'], 'alpha');
  let body: string;
  let space: string;
  if (color['colorSpace'] === 'oklch') {
    const [lightness = 0, chroma = 0, hue = 0] = parts;
    body = `${formatNumber(lightness * 100)}% ${formatNumber(chroma)} ${formatNumber(hue)}`;
    space = 'oklch';
  } else if (color['colorSpace'] === 'srgb') {
    body = parts.map((part) => formatNumber(part * 255)).join(' ');
    space = 'rgb';
  } else {
    throw new Error(`unsupported colour space ${String(color['colorSpace'])}`);
  }
  return alpha === 1 ? `${space}(${body})` : `${space}(${body} / ${formatNumber(alpha)})`;
}

function formatDimension(input: unknown): string {
  const dimension = asRecord(input, 'dimension');
  const value = numeric(dimension['value'], 'dimension value');
  return value === 0 ? '0' : `${formatNumber(value)}${String(dimension['unit'])}`;
}

function formatShadow(input: unknown): string {
  if (!Array.isArray(input)) throw new Error('shadow is not a list');
  return input
    .map((layer: unknown) => {
      const shadow = asRecord(layer, 'shadow layer');
      const offsets = ['offsetX', 'offsetY', 'blur', 'spread'].map((key) =>
        formatDimension(shadow[key]),
      );
      const inset = shadow['inset'] ? 'inset ' : '';
      return `${inset}${offsets.join(' ')} ${formatColor(shadow['color'])}`;
    })
    .join(', ');
}

/** Formats one resolved token's value as the CSS value `tokens.json` records. */
export function formatTokenValue(token: ResolvedToken): string {
  const type = token.$type;
  const value = token.$value;
  const recipe = token.$extensions['com.lostgradient.cinder'].cssRecipe;
  if (type === 'color') return formatColor(value);
  if (recipe && (type === 'number' || type === 'dimension') && /^-?[0-9.]+[a-z%]*$/.test(recipe)) {
    return recipe;
  }
  switch (type) {
    case 'dimension':
      return formatDimension(value);
    case 'duration': {
      const duration = asRecord(value, 'duration');
      return `${formatNumber(numeric(duration['value'], 'duration'))}${String(duration['unit'])}`;
    }
    case 'cubicBezier':
      if (!Array.isArray(value)) throw new Error('cubicBezier is not a list');
      return `cubic-bezier(${value.map((point) => formatNumber(numeric(point, 'point'))).join(', ')})`;
    case 'number':
    case 'fontWeight':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'shadow':
      return formatShadow(value);
    case 'fontFamily':
      if (!Array.isArray(value)) throw new Error('fontFamily is not a list');
      return value
        .map((family) => String(family))
        .map((family) => (family.includes(' ') ? `"${family}"` : family))
        .join(', ');
    default:
      throw new Error(`unsupported token type ${type}`);
  }
}

function tokenName(token: ResolvedToken): string {
  return token.$extensions['com.lostgradient.cinder'].cssProperty.slice(2);
}

function tokenUsage(token: ResolvedToken): string {
  // Python sliced by code point; Array.from keeps that, so a description is never cut mid-character.
  return Array.from((token.$description ?? '').trim())
    .slice(0, 1000)
    .join('');
}

/** The ids and namespaces whose tokens belong to one component rather than the system. */
export function componentNamespaces(manifest: ComponentManifest): Set<string> {
  const namespaces = new Set(manifest.components.map((component) => component.id));
  for (const namespace of manifest.package.tokenNamespaces) {
    if (!SYSTEM_NAMESPACES.has(namespace)) namespaces.add(namespace);
  }
  return namespaces;
}

/** The inputs to {@link buildTokens}. */
export type TokenSources = {
  light: ResolvedContext;
  dark: ResolvedContext;
  manifest: ComponentManifest;
  /** The source commit, recorded in `meta.ref`. */
  sha: string;
  /** The sync date, `YYYY-MM-DD`, recorded in `meta.synced`. */
  synced: string;
};

/** The output of {@link buildTokens}. */
export type TokenBuild = {
  /** The `tokens.json` document. */
  document: Record<string, unknown>;
  /** The `tokens.css` text. */
  css: string;
  /** How many source tokens `tokens.json` carries: colours, families and font families. */
  count: number;
  /** Tokens left out, or kept with a caveat, each with its reason. */
  skipped: string[];
};

type Routed = {
  colors: ThemedToken[];
  families: Record<FamilyName, Array<PlainToken | ThemedToken>>;
  fontFamilies: Map<string, string>;
  typeRoles: Array<{ path: string; token: ResolvedToken; value: string }>;
  typeSizes: Array<{ path: string; token: ResolvedToken; value: string }>;
  skipped: string[];
};

function familyFor(
  path: string,
  token: ResolvedToken,
  components: Set<string>,
): FamilyName | undefined {
  const head = path.split('.')[0] ?? '';
  const category = token.$extensions['com.lostgradient.cinder'].category;
  if (components.has(head)) return category === 'spacing' ? 'componentSpacing' : 'componentSizing';
  if (category === 'motion') return token.$type === 'cubicBezier' ? 'easing' : 'duration';
  return lookup(CATEGORY_FAMILIES, category);
}

function routeTokens(sources: TokenSources): Routed {
  const components = componentNamespaces(sources.manifest);
  const routed: Routed = {
    colors: [],
    families: Object.fromEntries(
      FAMILY_NAMES.map((name) => [name, []]),
    ) as unknown as Routed['families'],
    fontFamilies: new Map(),
    typeRoles: [],
    typeSizes: [],
    skipped: [],
  };
  for (const [path, token] of Object.entries(sources.light)) {
    let light: string;
    let dark: string;
    try {
      light = formatTokenValue(token);
      const darkToken = lookup(sources.dark, path);
      dark = darkToken ? formatTokenValue(darkToken) : light;
    } catch (error) {
      routed.skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const name = tokenName(token);
    const usage = tokenUsage(token);
    if (token.$type === 'color') {
      routed.colors.push({ name, usage, value: { light, dark } });
      continue;
    }
    if (token.$type === 'shadow') {
      routed.families.shadow.push({ name, usage, value: { light, dark } });
      continue;
    }
    if (light !== dark) {
      routed.skipped.push(`${path}: differs by theme outside color/shadow (${light} / ${dark})`);
    }
    const entry: PlainToken = { name, usage, value: light };
    const segments = path.split('.');
    if (token.$type === 'fontFamily') {
      routed.fontFamilies.set(`${segments[0]}-${segments[1]}`, light);
    } else if (path.startsWith('font.size.')) {
      routed.typeSizes.push({ path, token, value: light });
      routed.families.typeMetrics.push(entry);
    } else if (path.startsWith('type-role.')) {
      routed.typeRoles.push({ path, token, value: light });
      routed.families.typeMetrics.push(entry);
    } else {
      const family = familyFor(path, token, components);
      if (family) routed.families[family].push(entry);
      else {
        const category = token.$extensions['com.lostgradient.cinder'].category;
        routed.skipped.push(`${path}: no family for category ${category}`);
      }
    }
  }
  return routed;
}

function typeSection(routed: Routed) {
  const sans = routed.fontFamilies.get('font-sans');
  const mono = routed.fontFamilies.get('font-mono');
  if (sans === undefined || mono === undefined) throw new Error('missing font.sans or font.mono');
  const roles: TypeStyle[] = routed.typeRoles.map(({ path, token, value }) => {
    const role = path.split('.')[1] ?? '';
    const sample = lookup(ROLE_SAMPLES, role);
    if (sample === undefined) throw new Error(`no sample text for type role ${role}`);
    return {
      name: role,
      fontSize: value,
      lineHeight: role.endsWith('title') ? 1.3 : 1.5,
      fontWeight: lookup(ROLE_WEIGHTS, role) ?? 400,
      usage: `${tokenUsage(token)} CSS: var(--${tokenName(token)}).`,
      ...(path.endsWith('code') ? { family: 'mono' } : {}),
      sample,
    };
  });
  const scale: TypeStyle[] = routed.typeSizes.map(({ token, value }) => ({
    name: tokenName(token).replace('cinder-', ''),
    fontSize: value,
    lineHeight: 1.5,
    fontWeight: 400,
    usage: `${tokenUsage(token)} CSS: var(--${tokenName(token)}). Line height shown at --cinder-leading-normal.`,
  }));
  // Type roles carry no line height in the source; the Roles group shows them at a snug 1.3 for
  // titles and 1.5 for text.
  return {
    fonts: [] as string[],
    families: { sans, mono },
    groups: [
      { name: 'Roles', family: 'sans', styles: roles },
      { name: 'Scale', family: 'sans', styles: scale },
    ],
  };
}

function isThemed(token: PlainToken | ThemedToken): token is ThemedToken {
  return typeof token.value !== 'string';
}

function tokensCss(routed: Routed, type: ReturnType<typeof typeSection>): string {
  const themed = [...routed.colors, ...routed.families.shadow.filter(isThemed)];
  const lines = [
    '/* Cinder — generated from tokens.json */',
    "/* Wrapped in the lowest cascade layer: components/bundle.css carries Cinder's real token declarations, which win. */",
    '@layer cinder-design-system-tokens {',
    ':root, [data-theme="light"] {',
    ...themed.map((token) => `  --${token.name}: ${token.value.light};`),
    '}',
    '[data-theme="dark"] {',
    ...themed
      .filter((token) => token.value.dark !== token.value.light)
      .map((token) => `  --${token.name}: ${token.value.dark};`),
    '}',
    ':root {',
  ];
  for (const family of FAMILY_NAMES) {
    if (family === 'shadow') continue;
    for (const token of routed.families[family]) {
      if (!isThemed(token)) lines.push(`  --${token.name}: ${token.value};`);
    }
  }
  for (const [key, value] of Object.entries(type.families))
    lines.push(`  --font-${key}: ${value};`);
  lines.push('}');
  for (const group of type.groups) {
    for (const style of group.styles) {
      const family = style.family ?? group.family;
      lines.push(
        `.${style.name} { font-family: var(--font-${family}); font-size: ${style.fontSize}; line-height: ${style.lineHeight}; font-weight: ${style.fontWeight}; }`,
      );
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Builds `tokens.json` and `tokens.css`, failing on a family over the cap or a duplicate name. */
export function buildTokens(sources: TokenSources): TokenBuild {
  const routed = routeTokens(sources);
  const type = typeSection(routed);
  const document: Record<string, unknown> = {
    name: 'Cinder',
    version: 1,
    meta: {
      source: 'github',
      repo: 'stevekinney/corvidae',
      ref: `main@${sources.sha}`,
      package: 'components/cinder',
      paths: sourcePaths,
      synced: sources.synced,
    },
    color: {
      themes: [
        { id: 'light', name: 'Light' },
        { id: 'dark', name: 'Dark' },
      ],
      tokens: routed.colors,
    },
    type,
  };
  for (const family of FAMILY_NAMES) {
    const tokens = routed.families[family];
    if (tokens.length === 0) continue;
    if (tokens.length > FAMILY_TOKEN_CAP) {
      throw new Error(`${family} has ${tokens.length} tokens (cap ${FAMILY_TOKEN_CAP})`);
    }
    document[family] = { note: FAMILY_NOTES[family], tokens };
  }
  const names = [
    ...routed.colors.map((token) => token.name),
    ...FAMILY_NAMES.flatMap((family) => routed.families[family].map((token) => token.name)),
  ];
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicates.length > 0) throw new Error(`duplicate token names: ${duplicates.join(', ')}`);
  return {
    document,
    css: tokensCss(routed, type),
    count: names.length + Object.keys(type.families).length,
    skipped: routed.skipped,
  };
}
