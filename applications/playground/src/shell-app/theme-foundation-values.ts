/**
 * The pure rules of the foundation editors (COR-489): which editor a DTCG type gets, how a
 * `$value` becomes the text fields an editor shows, and how those fields become a `$value`
 * again. Fields keep what the user typed as text, so partial input stays visible; a value is
 * only built when every field parses, and building never coerces: a number stays a number, a
 * dimension keeps its unit, a font weight keeps its name, and a font stack keeps its order.
 *
 * Numeric limits come from the catalogue row's CSS usage profile (`PROFILES`,
 * `profileRangeViolation`), never from a table of this module's own.
 */

import { profileRangeViolation, type ProfileDefinition } from '@lostgradient/cinder/tokens/runtime';

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import type { JsonValue } from './theme-draft-types.ts';
import { isAliasValue } from './theme-token-edit.ts';

export const FOUNDATION_EDITOR_TYPES = [
  'dimension',
  'fontFamily',
  'fontWeight',
  'number',
  'duration',
  'cubicBezier',
] as const;
export type FoundationKind = (typeof FOUNDATION_EDITOR_TYPES)[number];

export function foundationKindOf(type: string): FoundationKind | null {
  return (FOUNDATION_EDITOR_TYPES as readonly string[]).includes(type)
    ? (type as FoundationKind)
    : null;
}

/** The units DTCG 2025.10 allows. */
export const UNITS: Record<'dimension' | 'duration', readonly string[]> = {
  dimension: ['px', 'rem'],
  duration: ['ms', 's'],
};

export const MAX_FAMILIES = 20;

export type FoundationFields =
  | { kind: 'dimension' | 'duration'; amount: string; unit: string }
  | { kind: 'number' | 'fontWeight'; amount: string }
  | { kind: 'fontFamily'; families: string[]; shape: 'string' | 'array' }
  | { kind: 'cubicBezier'; points: [string, string, string, string] };

export const BEZIER_PARTS = ['x1', 'y1', 'x2', 'y2'] as const;

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Strict number text: no `Infinity`, hex, separators, or empty input. */
export function parseNumberText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!NUMBER_TEXT.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const isRecord = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fields for a literal `$value`, or `null` when its shape is not this editor's. */
export function fieldsFromValue(kind: FoundationKind, value: JsonValue): FoundationFields | null {
  if (isAliasValue(value)) return null;
  switch (kind) {
    case 'dimension':
    case 'duration': {
      if (!isRecord(value)) return null;
      const amount = value['value'];
      const unit = value['unit'];
      if (typeof amount !== 'number' || typeof unit !== 'string') return null;
      return { kind, amount: String(amount), unit };
    }
    case 'number':
      return typeof value === 'number' ? { kind, amount: String(value) } : null;
    case 'fontWeight':
      return typeof value === 'number' || typeof value === 'string'
        ? { kind, amount: String(value) }
        : null;
    case 'fontFamily': {
      if (typeof value === 'string' && !isAliasValue(value)) {
        return { kind, families: [value], shape: 'string' };
      }
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        return { kind, families: value, shape: 'array' };
      }
      return null;
    }
    case 'cubicBezier': {
      if (!Array.isArray(value) || value.length !== 4) return null;
      if (!value.every((entry) => typeof entry === 'number')) return null;
      return { kind, points: value.map(String) as [string, string, string, string] };
    }
  }
}

export type FieldErrors = Partial<Record<string, string>>;
export type BuiltValue = { ok: true; value: JsonValue } | { ok: false; errors: FieldErrors };

/** What the profile allows, in words, labeled as Cinder's CSS limit rather than DTCG's. */
export function profileHint(profile: ProfileDefinition | undefined): string {
  const range = profile?.range;
  if (profile === undefined || range === undefined) return '';
  const parts: string[] = [];
  if (range.integer === true) parts.push('a whole number');
  else parts.push('finite');
  const { min, max } = range;
  if (min !== undefined && max !== undefined) parts.push(`${min} to ${max}`);
  else if (min !== undefined)
    parts.push(range.minExclusive === true ? `above ${min}` : `${min} or more`);
  else if (max !== undefined) parts.push(`${max} or less`);
  const keywords = profile.keywords === undefined ? '' : ' Named weights are accepted.';
  return `Cinder limit for ${profile.id}: ${parts.join(', ')}.${keywords}`;
}

function rangeProblem(row: CatalogueRow, part: number | string): string | undefined {
  if (row.profile?.range === undefined) return undefined;
  const problem = profileRangeViolation(row.profile, part);
  return problem === undefined ? undefined : `Cinder limit: ${problem}.`;
}

function validateAmount(text: string): { amount?: number; error?: string } {
  const amount = parseNumberText(text);
  if (amount === undefined) {
    return {
      error: text.trim() === '' ? 'Enter a number.' : `“${text.trim()}” is not a finite number.`,
    };
  }
  return { amount };
}

/** Build the `$value` from fields, or name each field that is wrong. */
export function valueFromFields(row: CatalogueRow, fields: FoundationFields): BuiltValue {
  switch (fields.kind) {
    case 'dimension':
    case 'duration': {
      const { amount, error } = validateAmount(fields.amount);
      if (amount === undefined) return { ok: false, errors: { amount: error! } };
      const allowed = UNITS[fields.kind];
      if (!allowed.includes(fields.unit)) {
        return { ok: false, errors: { unit: `Use ${allowed.join(' or ')}.` } };
      }
      const problem = rangeProblem(row, amount);
      if (problem !== undefined) return { ok: false, errors: { amount: problem } };
      return { ok: true, value: { value: amount, unit: fields.unit } };
    }
    case 'number': {
      const { amount, error } = validateAmount(fields.amount);
      if (amount === undefined) return { ok: false, errors: { amount: error! } };
      const problem = rangeProblem(row, amount);
      if (problem !== undefined) return { ok: false, errors: { amount: problem } };
      return { ok: true, value: amount };
    }
    case 'fontWeight': {
      const text = fields.amount.trim();
      const keywords = row.profile?.keywords ?? [];
      if (keywords.includes(text)) return { ok: true, value: text };
      const amount = parseNumberText(text);
      if (amount === undefined) {
        return {
          ok: false,
          errors: {
            amount:
              text === ''
                ? 'Enter a weight from 1 to 1000 or a name such as bold.'
                : `“${text}” is neither a number from 1 to 1000 nor a weight name such as bold.`,
          },
        };
      }
      const problem = rangeProblem(row, amount);
      if (problem !== undefined) return { ok: false, errors: { amount: problem } };
      return { ok: true, value: amount };
    }
    case 'fontFamily':
      return buildFamilies(fields);
    case 'cubicBezier':
      return buildBezier(fields.points);
  }
}

const FORBIDDEN_CHARACTERS = new Set([',', ';', '{', '}', '"', '\\']);

/** A family name may hold no control character, comma, quote, brace, semicolon or backslash. */
function hasForbiddenCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || FORBIDDEN_CHARACTERS.has(name.charAt(index))) return true;
  }
  return false;
}

function buildFamilies(fields: Extract<FoundationFields, { kind: 'fontFamily' }>): BuiltValue {
  const errors: FieldErrors = {};
  const names = fields.families.map((family) => family.trim());
  if (names.length === 0) errors['families'] = 'Add at least one font family.';
  if (names.length > MAX_FAMILIES) errors['families'] = `Use ${MAX_FAMILIES} families or fewer.`;
  names.forEach((name, index) => {
    if (name === '') errors[`family-${index}`] = 'Enter a family name or remove this row.';
    else if (hasForbiddenCharacter(name)) {
      errors[`family-${index}`] = 'A family name cannot contain commas, quotes, braces or ;.';
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const single = fields.shape === 'string' && names.length === 1;
  return { ok: true, value: single ? names[0]! : names };
}

function buildBezier(points: readonly string[]): BuiltValue {
  const errors: FieldErrors = {};
  const numbers: number[] = [];
  BEZIER_PARTS.forEach((part, index) => {
    const parsed = parseNumberText(points[index] ?? '');
    if (parsed === undefined) {
      errors[part] = `${part} must be a finite number.`;
      return;
    }
    if ((part === 'x1' || part === 'x2') && (parsed < 0 || parsed > 1)) {
      errors[part] = `${part} must be between 0 and 1.`;
    }
    numbers.push(parsed);
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: numbers };
}

/** A stable text form of the fields: the input buffer stores it and edits compare against it. */
export function serializeFields(fields: FoundationFields): string {
  return JSON.stringify(fields);
}

export function deserializeFields(
  kind: FoundationKind,
  text: string | undefined,
): FoundationFields | null {
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as FoundationFields;
    return parsed.kind === kind ? parsed : null;
  } catch {
    return null;
  }
}

// --- sliders ----------------------------------------------------------------------------

export type SliderSpec = { min: number; max: number; step: number };

/** Sliders for the three numeric profiles where dragging is natural; each has a numeric field. */
export function sliderSpecFor(row: CatalogueRow): SliderSpec | null {
  switch (row.profile?.id) {
    case 'opacity':
      return { min: 0, max: 1, step: 0.01 };
    case 'font-weight':
      return { min: 1, max: 1000, step: 1 };
    case 'line-height':
      return row.type === 'number' ? { min: 0, max: 3, step: 0.05 } : null;
    default:
      return null;
  }
}

// --- CSS lengths for the previews ---------------------------------------------------------

const LENGTH = /^(-?\d*\.?\d+)(px|rem)$/;

/** A CSS `px` or `rem` length in pixels, or `undefined` for anything else. */
export function cssLengthToPx(css: string | undefined): number | undefined {
  const match = css === undefined ? null : LENGTH.exec(css.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === 'rem' ? amount * 16 : amount;
}

/** Follow whole-value `var(--name)` aliases in a CSS property map to a final value. */
export function resolveCssValue(
  values: ReadonlyMap<string, string>,
  property: string,
): string | undefined {
  let current = values.get(property);
  for (let hops = 0; hops < 8 && current !== undefined; hops += 1) {
    const match = /^var\((--[\w-]+)\)$/.exec(current.trim());
    if (match === null) return current;
    current = values.get(match[1]!);
  }
  return current;
}

/** Blank fields of a kind, for a token whose literal could not be read. */
export function blankFields(kind: FoundationKind): FoundationFields {
  switch (kind) {
    case 'dimension':
      return { kind, amount: '', unit: 'px' };
    case 'duration':
      return { kind, amount: '', unit: 'ms' };
    case 'number':
    case 'fontWeight':
      return { kind, amount: '' };
    case 'fontFamily':
      return { kind, families: [], shape: 'array' };
    case 'cubicBezier':
      return { kind, points: ['', '', '', ''] };
  }
}
