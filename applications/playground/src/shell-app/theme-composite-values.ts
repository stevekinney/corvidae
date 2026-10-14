/**
 * The pure rules of the composite editors (COR-488): how a strokeStyle, border, transition,
 * shadow, gradient or typography `$value` becomes member fields, and how the fields become a
 * `$value` again. It extends the foundation rules (`theme-foundation-values.ts`), which build
 * every scalar member, and adds the pieces a composite needs:
 *
 * - A member that is a reference (`{token}` or `{"$ref": …}`) is kept verbatim as a
 *   reference and is only replaced by the author's explicit action.
 * - A member whose shape the editor does not read is kept verbatim as opaque data.
 * - Keys the editor does not own, and the original key order, survive a rebuild, so an
 *   unchanged composite round-trips to the identical value, and arrays keep their order.
 * - An unchanged color keeps the exact authored object; only an edited color is re-parsed.
 */

import { PROFILES, type ProfileDefinition } from '@lostgradient/cinder/tokens/runtime';

import {
  authoredText,
  colorToJson,
  parseColorText,
  readDtcgColor,
} from './theme-color-model.ts';
import type { JsonObject, JsonValue } from './theme-draft-types.ts';
import {
  blankFields,
  fieldsFromValue,
  valueFromFields,
  type FieldErrors,
  type FoundationFields,
  type FoundationKind,
} from './theme-foundation-values.ts';
import { isAliasValue } from './theme-token-edit.ts';

export const COMPOSITE_TYPES = [
  'strokeStyle',
  'border',
  'transition',
  'shadow',
  'gradient',
  'typography',
] as const;
export type CompositeType = (typeof COMPOSITE_TYPES)[number];

export const isCompositeType = (type: string): type is CompositeType =>
  (COMPOSITE_TYPES as readonly string[]).includes(type);

export const STROKE_KEYWORDS = [
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'outset',
  'inset',
] as const;
export const LINE_CAPS = ['round', 'butt', 'square'] as const;

type ScalarKind = Extract<FoundationKind, 'dimension' | 'duration' | 'number' | 'fontWeight'>;
export type MemberKind =
  | ScalarKind
  | 'color'
  | 'fontFamily'
  | 'cubicBezier'
  | 'boolean'
  | 'stroke';

export type MemberSpec = {
  key: string;
  label: string;
  kind: MemberKind;
  optional?: boolean;
  /** The limit the member's number must honor; `undefined` for a signed or unbounded one. */
  profile?: ProfileDefinition | undefined;
};

const POSITION: ProfileDefinition = {
  id: 'gradient-position',
  description: 'A stop position from 0 to 1.',
  types: ['number'],
  cssUsage: [],
  range: { part: 'number', finite: true, min: 0, max: 1 },
};

export const MEMBER_SPECS: Record<Exclude<CompositeType, 'strokeStyle'>, readonly MemberSpec[]> = {
  shadow: [
    { key: 'color', label: 'Color', kind: 'color' },
    { key: 'offsetX', label: 'Offset X', kind: 'dimension', profile: PROFILES['offset'] },
    { key: 'offsetY', label: 'Offset Y', kind: 'dimension', profile: PROFILES['offset'] },
    { key: 'blur', label: 'Blur', kind: 'dimension', profile: PROFILES['blur'] },
    { key: 'spread', label: 'Spread', kind: 'dimension', profile: PROFILES['offset'] },
    { key: 'inset', label: 'Inset', kind: 'boolean', optional: true },
  ],
  gradient: [
    { key: 'color', label: 'Color', kind: 'color' },
    { key: 'position', label: 'Position', kind: 'number', profile: POSITION },
  ],
  border: [
    { key: 'color', label: 'Color', kind: 'color' },
    { key: 'width', label: 'Width', kind: 'dimension', profile: PROFILES['border-width'] },
    { key: 'style', label: 'Style', kind: 'stroke' },
  ],
  transition: [
    { key: 'duration', label: 'Duration', kind: 'duration', profile: PROFILES['duration'] },
    { key: 'delay', label: 'Delay', kind: 'duration', profile: PROFILES['duration'] },
    { key: 'timingFunction', label: 'Timing function', kind: 'cubicBezier' },
  ],
  typography: [
    { key: 'fontFamily', label: 'Font family', kind: 'fontFamily' },
    { key: 'fontSize', label: 'Font size', kind: 'dimension', profile: PROFILES['font-size'] },
    { key: 'fontWeight', label: 'Font weight', kind: 'fontWeight', profile: PROFILES['font-weight'] },
    {
      key: 'letterSpacing',
      label: 'Letter spacing',
      kind: 'dimension',
      profile: PROFILES['letter-spacing'],
    },
    { key: 'lineHeight', label: 'Line height', kind: 'number', profile: PROFILES['line-height'] },
  ],
};

export const DASH_SPEC: MemberSpec = {
  key: 'dash',
  label: 'Dash',
  kind: 'dimension',
  profile: PROFILES['border-width'],
};

// --- field model ---------------------------------------------------------------------------

export type Member =
  | { kind: 'ref'; value: JsonValue }
  | { kind: 'opaque'; value: JsonValue }
  | { kind: 'scalar'; fields: FoundationFields }
  | { kind: 'color'; text: string; original: JsonValue | null }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'stroke'; stroke: StrokeFields }
  | { kind: 'family'; fields: FoundationFields }
  | { kind: 'bezier'; fields: FoundationFields }
  | { kind: 'absent' };

export type StrokeFields = {
  /** A named style, or `null` when the stroke is the structured dash form. */
  named: string | null;
  /** The named style the author had before switching to the dash form, restored on return. */
  lastNamed?: string;
  dash: Member[];
  lineCap: string;
  extra: JsonObject;
  order: string[];
};

export type Layer = { members: Record<string, Member>; extra: JsonObject; order: string[] };

type Layers<T extends 'shadow' | 'gradient'> = {
  type: T;
  shape: 'array' | 'object';
  layers: Layer[];
};
type Single<T extends 'border' | 'transition' | 'typography'> = { type: T; layer: Layer };

// One union member per type, so narrowing on `type` separates them.
export type CompositeFields =
  | Layers<'shadow'>
  | Layers<'gradient'>
  | Single<'border'>
  | Single<'transition'>
  | Single<'typography'>
  | { type: 'strokeStyle'; stroke: StrokeFields };

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole `{token}` alias or a JSON-pointer `$ref` object: kept verbatim until replaced. */
export const isReferenceValue = (value: JsonValue | undefined): boolean =>
  isAliasValue(value) || (isRecord(value) && typeof value['$ref'] === 'string');

function blankMember(spec: MemberSpec): Member {
  switch (spec.kind) {
    case 'color':
      return { kind: 'color', text: '', original: null };
    case 'boolean':
      return { kind: 'absent' };
    case 'stroke':
      return { kind: 'stroke', stroke: namedStroke('solid') };
    case 'fontFamily':
      return { kind: 'family', fields: blankFields('fontFamily') };
    case 'cubicBezier':
      return { kind: 'bezier', fields: blankFields('cubicBezier') };
    default:
      return { kind: 'scalar', fields: blankFields(spec.kind) };
  }
}

const namedStroke = (named: string): StrokeFields => ({
  named,
  dash: [],
  lineCap: 'round',
  extra: {},
  order: [],
});

function readStroke(value: JsonValue): StrokeFields | null {
  if (typeof value === 'string') return namedStroke(value);
  if (!isRecord(value)) return null;
  const dashArray = value['dashArray'];
  const lineCap = value['lineCap'];
  if (!Array.isArray(dashArray) || typeof lineCap !== 'string') return null;
  const extra: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'dashArray' && key !== 'lineCap') extra[key] = entry;
  }
  return {
    named: null,
    dash: dashArray.map((entry) => readMember(DASH_SPEC, entry)),
    lineCap,
    extra,
    order: Object.keys(value),
  };
}

export function readMember(spec: MemberSpec, raw: JsonValue | undefined): Member {
  if (raw === undefined) return blankMember(spec);
  if (isReferenceValue(raw)) return { kind: 'ref', value: raw };
  switch (spec.kind) {
    case 'color': {
      const color = readDtcgColor(raw);
      return color === null
        ? { kind: 'opaque', value: raw }
        : { kind: 'color', text: authoredText(color), original: raw };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { kind: 'boolean', value: raw } : { kind: 'opaque', value: raw };
    case 'stroke': {
      const stroke = readStroke(raw);
      return stroke === null ? { kind: 'opaque', value: raw } : { kind: 'stroke', stroke };
    }
    case 'fontFamily':
    case 'cubicBezier': {
      const fields = fieldsFromValue(spec.kind, raw);
      if (fields === null) return { kind: 'opaque', value: raw };
      return spec.kind === 'fontFamily' ? { kind: 'family', fields } : { kind: 'bezier', fields };
    }
    default: {
      const fields = fieldsFromValue(spec.kind, raw);
      return fields === null ? { kind: 'opaque', value: raw } : { kind: 'scalar', fields };
    }
  }
}

function readLayer(specs: readonly MemberSpec[], value: JsonValue): Layer | null {
  if (!isRecord(value)) return null;
  const members: Record<string, Member> = {};
  for (const spec of specs) members[spec.key] = readMember(spec, value[spec.key]);
  const extra: JsonObject = {};
  const known = new Set(specs.map((spec) => spec.key));
  for (const [key, entry] of Object.entries(value)) if (!known.has(key)) extra[key] = entry;
  return { members, extra, order: Object.keys(value) };
}

/** The member fields for a literal `$value`, or `null` when its shape is not a composite's. */
export function compositeFromValue(type: CompositeType, value: JsonValue): CompositeFields | null {
  if (isReferenceValue(value)) return null;
  if (type === 'strokeStyle') {
    const stroke = readStroke(value);
    return stroke === null ? null : { type, stroke };
  }
  const specs = MEMBER_SPECS[type];
  if (type === 'shadow' || type === 'gradient') {
    const entries = Array.isArray(value) ? value : [value];
    const layers = entries.map((entry) => readLayer(specs, entry));
    if (layers.some((layer) => layer === null)) return null;
    return { type, shape: Array.isArray(value) ? 'array' : 'object', layers: layers as Layer[] };
  }
  const layer = readLayer(specs, value);
  return layer === null ? null : { type, layer };
}

/** Blank fields for a token whose literal could not be read. */
export function blankComposite(type: CompositeType): CompositeFields {
  if (type === 'strokeStyle') return { type, stroke: namedStroke('solid') };
  const layer = newLayer(type);
  if (type === 'shadow' || type === 'gradient') return { type, shape: 'array', layers: [layer] };
  return { type, layer };
}

const GREY = { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.25 };
const px = (amount: string): Member => ({
  kind: 'scalar',
  fields: { kind: 'dimension', amount, unit: 'px' },
});

/** A new layer or stop with sensible defaults. */
export function newLayer(type: Exclude<CompositeType, 'strokeStyle'>): Layer {
  const specs = MEMBER_SPECS[type];
  const members = Object.fromEntries(specs.map((spec) => [spec.key, blankMember(spec)]));
  if (type === 'shadow') {
    Object.assign(members, {
      color: { kind: 'color', text: authoredText(readDtcgColor(GREY)!), original: GREY },
      offsetX: px('0'),
      offsetY: px('2'),
      blur: px('4'),
      spread: px('0'),
    });
  } else if (type === 'gradient') {
    members['color'] = { kind: 'color', text: authoredText(readDtcgColor(GREY)!), original: GREY };
    members['position'] = { kind: 'scalar', fields: { kind: 'number', amount: '1' } };
  }
  return { members, extra: {}, order: [] };
}

// --- building ------------------------------------------------------------------------------

export type CompositeBuild = { ok: true; value: JsonValue } | { ok: false; errors: FieldErrors };

const rowShim = (profile: ProfileDefinition | undefined) =>
  ({ profile }) as Parameters<typeof valueFromFields>[0];

function buildMember(
  spec: MemberSpec,
  member: Member,
  at: string,
  errors: FieldErrors,
): JsonValue | undefined {
  switch (member.kind) {
    case 'ref':
    case 'opaque':
      return member.value;
    case 'absent':
      return undefined;
    case 'boolean':
      return member.value;
    case 'color': {
      if (member.original !== null) {
        const original = readDtcgColor(member.original);
        if (original !== null && authoredText(original) === member.text) return member.original;
      }
      const parsed = parseColorText(member.text);
      if (!parsed.ok) {
        errors[at] = parsed.message;
        return undefined;
      }
      return colorToJson(parsed.color);
    }
    case 'stroke':
      return buildStroke(member.stroke, at, errors);
    case 'scalar':
    case 'family':
    case 'bezier': {
      const built = valueFromFields(rowShim(spec.profile), member.fields);
      if (built.ok) return built.value;
      const [first] = Object.values(built.errors);
      errors[at] = first ?? 'Invalid value.';
      return undefined;
    }
  }
}

function buildStroke(stroke: StrokeFields, at: string, errors: FieldErrors): JsonValue | undefined {
  if (stroke.named !== null) {
    if (!(STROKE_KEYWORDS as readonly string[]).includes(stroke.named)) {
      errors[at] = `“${stroke.named}” is not a stroke style. Use ${STROKE_KEYWORDS.join(', ')}.`;
    }
    return stroke.named;
  }
  if (stroke.dash.length === 0) errors[at] = 'Add at least one dash length.';
  if (!(LINE_CAPS as readonly string[]).includes(stroke.lineCap)) {
    errors[`${at}.lineCap`] = `Use ${LINE_CAPS.join(', ')}.`;
  }
  const dash = stroke.dash.map((member, index) =>
    buildMember(DASH_SPEC, member, `${at}.dashArray.${index}`, errors),
  );
  const parts: JsonObject = {};
  const built: JsonObject = { dashArray: dash as JsonValue[], lineCap: stroke.lineCap };
  for (const key of [...stroke.order, 'dashArray', 'lineCap']) {
    if (Object.hasOwn(parts, key)) continue;
    const value = Object.hasOwn(built, key) ? built[key] : stroke.extra[key];
    if (value !== undefined) parts[key] = value;
  }
  return parts;
}

function buildLayer(
  specs: readonly MemberSpec[],
  layer: Layer,
  at: string,
  errors: FieldErrors,
): JsonObject {
  const built: JsonObject = {};
  for (const spec of specs) {
    const value = buildMember(spec, layer.members[spec.key] ?? { kind: 'absent' }, `${at}${spec.key}`, errors);
    if (value !== undefined) built[spec.key] = value;
  }
  const result: JsonObject = {};
  for (const key of [...layer.order, ...specs.map((spec) => spec.key)]) {
    if (Object.hasOwn(result, key)) continue;
    const value = Object.hasOwn(built, key) ? built[key] : layer.extra[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const MIN_LAYERS: Record<'shadow' | 'gradient', number> = { shadow: 1, gradient: 2 };

/** Build the `$value`, or name each member that is wrong by its path (`layers.1.blur`). */
export function compositeToValue(fields: CompositeFields): CompositeBuild {
  const errors: FieldErrors = {};
  let value: JsonValue | undefined;
  if (fields.type === 'strokeStyle') {
    value = buildStroke(fields.stroke, 'stroke', errors);
  } else if (fields.type === 'shadow' || fields.type === 'gradient') {
    if (fields.layers.length < MIN_LAYERS[fields.type]) {
      errors['layers'] =
        fields.type === 'shadow' ? 'A shadow needs at least one layer.' : 'A gradient needs at least two stops.';
    }
    const specs = MEMBER_SPECS[fields.type];
    const built = fields.layers.map((layer, index) =>
      buildLayer(specs, layer, `layers.${index}.`, errors),
    );
    value = fields.shape === 'object' && built.length === 1 ? built[0]! : built;
  } else {
    value = buildLayer(MEMBER_SPECS[fields.type], fields.layer, '', errors);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: value! };
}

/** A stable text form of the fields: the input buffer stores it and edits compare against it. */
export const serializeComposite = (fields: CompositeFields): string => JSON.stringify(fields);

export function deserializeComposite(
  type: CompositeType,
  text: string | undefined,
): CompositeFields | null {
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as CompositeFields;
    return parsed.type === type ? parsed : null;
  } catch {
    return null;
  }
}

// --- array operations ----------------------------------------------------------------------

/** Move `list[index]` by `delta` (-1 up, +1 down); the list is returned unchanged at an end. */
export function moved<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
