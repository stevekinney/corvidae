/**
 * Which families of a font stack this browser can actually draw (COR-489). A theme names
 * families; whether they exist is a property of the machine that renders it, so a named family
 * that is not installed here is reported as environment-dependent. Nothing is fetched and no
 * font is uploaded: the probe only measures text with fonts already present.
 *
 * `environmentDependentFamilies` is the hook the export and report surfaces reuse (COR-486,
 * COR-259): it takes a stack and a probe and returns the families they must flag.
 */

/** CSS generic families and system aliases: always resolvable, never environment-dependent. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
]);

export const ENVIRONMENT_DEPENDENT_NOTICE =
  'Environment-dependent: this font is not available here, and other devices may differ.';

export type FontProbe = (family: string) => boolean;

export const isGenericFamily = (family: string): boolean =>
  GENERIC_FAMILIES.has(family.trim().toLowerCase());

/** The ordered stack as the families a theme names, from either `$value` shape. */
export function familiesOf(value: string | readonly string[]): string[] {
  return typeof value === 'string' ? [value] : [...value];
}

/**
 * The families of a stack that are named (not generic) and that the probe cannot find. The
 * result keeps stack order and never repeats a name.
 */
export function environmentDependentFamilies(
  stack: string | readonly string[],
  probe: FontProbe,
): string[] {
  const seen = new Set<string>();
  const flagged: string[] = [];
  for (const family of familiesOf(stack)) {
    const name = family.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    if (!isGenericFamily(name) && !probe(name)) flagged.push(name);
  }
  return flagged;
}

/**
 * A probe backed by canvas text measurement: a family exists when text set in it measures
 * differently from the same text in two different fallbacks. The canvas is the only
 * resource it touches; with none (no DOM) every named family reads as unavailable.
 */
export function createCanvasFontProbe(documentLike: Pick<Document, 'createElement'>): FontProbe {
  const context = documentLike.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli0Oo@#WwQq';
  const baselines = ['monospace', 'serif'] as const;
  const cache = new Map<string, boolean>();
  const widthOf = (font: string): number => {
    if (context === null) return 0;
    context.font = `72px ${font}`;
    return context.measureText(sample).width;
  };
  const fallbackWidths = baselines.map((baseline) => widthOf(baseline));
  return (family) => {
    if (context === null) return false;
    const cached = cache.get(family);
    if (cached !== undefined) return cached;
    const quoted = `"${family.replaceAll('"', '')}"`;
    const found = baselines.some(
      (baseline, index) => widthOf(`${quoted}, ${baseline}`) !== fallbackWidths[index],
    );
    cache.set(family, found);
    return found;
  };
}

let sharedProbe: FontProbe | null = null;

/** The browser's probe, created on first use; without a DOM every named family reads as absent. */
export function browserFontProbe(): FontProbe {
  if (sharedProbe === null) {
    sharedProbe = typeof document === 'undefined' ? () => false : createCanvasFontProbe(document);
  }
  return sharedProbe;
}
