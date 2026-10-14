/** Creating and parsing the Cinder Theme v1 envelope, with the input limits enforced. */

import {
  checkCssOverrideLimits,
  checkDocumentLimits,
  checkFileSize,
  type LimitViolation,
} from './theme-draft-limits.ts';
import {
  emptyOverrides,
  OVERRIDE_SCOPES,
  THEME_FORMAT,
  THEME_VERSION,
  type JsonObject,
  type ThemeBase,
  type ThemeEnvelope,
} from './theme-draft-types.ts';

export function createEnvelope(id: string, name: string, base: ThemeBase): ThemeEnvelope {
  return {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    id,
    name,
    base,
    overrides: emptyOverrides(),
    cssOverrides: {},
  };
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** All structural limits of one envelope: base documents, override trees, CSS-only values. */
export function envelopeLimitViolations(envelope: ThemeEnvelope): LimitViolation[] {
  return [
    ...checkDocumentLimits(envelope.base.documents),
    ...checkDocumentLimits({ ...envelope.overrides }),
    ...checkCssOverrideLimits(envelope.cssOverrides),
  ];
}

export type ParsedEnvelope =
  | { ok: true; envelope: ThemeEnvelope }
  | { ok: false; reason: 'invalid-json' | 'unrecognized'; message: string }
  | { ok: false; reason: 'limits'; violations: LimitViolation[]; message: string };

/** Structural validation of an unknown value; it does not judge the base's compatibility. */
export function envelopeFromValue(value: unknown): ThemeEnvelope | null {
  if (!isObject(value)) return null;
  const { format, version, id, name, base, overrides, cssOverrides } = value;
  if (format !== THEME_FORMAT || version !== THEME_VERSION) return null;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null;
  if (!isObject(base) || !isObject(overrides) || !isObject(cssOverrides)) return null;
  const { packageVersion, sourceDigest, documents, resolver } = base;
  if (typeof packageVersion !== 'string' || typeof sourceDigest !== 'string') return null;
  if (!isObject(documents) || resolver === undefined) return null;
  const scopes = emptyOverrides();
  for (const scope of OVERRIDE_SCOPES) {
    const tree = overrides[scope];
    if (!isObject(tree)) return null;
    scopes[scope] = tree;
  }
  for (const byContext of Object.values(cssOverrides)) {
    if (!isObject(byContext)) return null;
    if (Object.values(byContext).some((css) => typeof css !== 'string')) return null;
  }
  return {
    format,
    version,
    id,
    name,
    base: { packageVersion, sourceDigest, resolver, documents },
    overrides: scopes,
    cssOverrides: cssOverrides as ThemeEnvelope['cssOverrides'],
  };
}

export function parseThemeEnvelope(text: string): ParsedEnvelope {
  const size = checkFileSize(text);
  if (size.length > 0) {
    return { ok: false, reason: 'limits', violations: size, message: 'The file is over 1 MiB.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-json',
      message: error instanceof Error ? error.message : 'Invalid JSON.',
    };
  }
  const envelope = envelopeFromValue(value);
  if (envelope === null) {
    return { ok: false, reason: 'unrecognized', message: 'Not a Cinder Theme v1 envelope.' };
  }
  const violations = envelopeLimitViolations(envelope);
  if (violations.length > 0) {
    return {
      ok: false,
      reason: 'limits',
      violations,
      message: `The theme exceeds the ${violations[0]?.code ?? 'data'} limit.`,
    };
  }
  return { ok: true, envelope };
}

/** A theme name as a file name stem: lowercase letters and digits joined by single hyphens. */
export function themeFileSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'theme'
  );
}

/** The lossless download of one theme: the envelope only, as stable pretty JSON. */
export function envelopeDownload(envelope: ThemeEnvelope): {
  filename: string;
  mime: string;
  text: string;
} {
  return {
    filename: `${themeFileSlug(envelope.name)}-${envelope.id.slice(0, 8)}.cinder-theme.json`,
    mime: 'application/json',
    text: `${JSON.stringify(envelope, null, 2)}\n`,
  };
}
