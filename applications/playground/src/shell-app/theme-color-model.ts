/**
 * The color model behind the color editor and palette generation (COR-263): reading and
 * writing DTCG color values, converting through Culori, and describing a color's gamut.
 *
 * A DTCG color keeps its authored space. Every conversion in this module is a derived view
 * (a preview, a gamut test, an OKLCH proposal); nothing here rewrites an authored value into
 * another space, and nothing clamps. Callers that want a different space ask for it by name.
 */

import { converter, formatCss, parse, type Color } from 'culori';

import { inOutputGamut } from './theme-chroma-grid.ts';
import type { JsonObject, JsonValue } from './theme-draft-types.ts';

export type DtcgColor = {
  colorSpace: string;
  components: Array<number | 'none'>;
  alpha?: number;
  hex?: string;
};

export type ChannelDefinition = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Authored units per Culori unit (hsl and hwb percentages are 100 in DTCG, 1 in Culori). */
  scale: number;
};

export type SpaceDefinition = {
  /** The DTCG `colorSpace` name. */
  space: string;
  /** The Culori mode. */
  mode: string;
  label: string;
  channels: readonly [ChannelDefinition, ChannelDefinition, ChannelDefinition];
};

const unit = (key: string, label: string, max = 1): ChannelDefinition => ({
  key,
  label,
  min: 0,
  max,
  step: 0.001,
  scale: 1,
});
const open = (key: string, label: string, bound: number, step = 0.001): ChannelDefinition => ({
  key,
  label,
  min: -bound,
  max: bound,
  step,
  scale: 1,
});
const hue: ChannelDefinition = { key: 'h', label: 'Hue', min: 0, max: 360, step: 0.1, scale: 1 };
const percent = (key: string, label: string): ChannelDefinition => ({
  key,
  label,
  min: 0,
  max: 100,
  step: 0.1,
  scale: 100,
});

const rgbChannels = [unit('r', 'Red'), unit('g', 'Green'), unit('b', 'Blue')] as const;

const DEFINITIONS: readonly SpaceDefinition[] = [
  { space: 'srgb', mode: 'rgb', label: 'sRGB', channels: rgbChannels },
  { space: 'srgb-linear', mode: 'lrgb', label: 'Linear sRGB', channels: rgbChannels },
  { space: 'display-p3', mode: 'p3', label: 'Display P3', channels: rgbChannels },
  { space: 'a98-rgb', mode: 'a98', label: 'A98 RGB', channels: rgbChannels },
  { space: 'prophoto-rgb', mode: 'prophoto', label: 'ProPhoto RGB', channels: rgbChannels },
  { space: 'rec2020', mode: 'rec2020', label: 'Rec. 2020', channels: rgbChannels },
  {
    space: 'hsl',
    mode: 'hsl',
    label: 'HSL',
    channels: [hue, percent('s', 'Saturation'), percent('l', 'Lightness')],
  },
  {
    space: 'hwb',
    mode: 'hwb',
    label: 'HWB',
    channels: [hue, percent('w', 'Whiteness'), percent('b', 'Blackness')],
  },
  {
    space: 'lab',
    mode: 'lab',
    label: 'Lab',
    channels: [
      { key: 'l', label: 'Lightness', min: 0, max: 100, step: 0.1, scale: 1 },
      open('a', 'a axis', 160, 0.1),
      open('b', 'b axis', 160, 0.1),
    ],
  },
  {
    space: 'lch',
    mode: 'lch',
    label: 'LCH',
    channels: [
      { key: 'l', label: 'Lightness', min: 0, max: 100, step: 0.1, scale: 1 },
      { key: 'c', label: 'Chroma', min: 0, max: 230, step: 0.1, scale: 1 },
      hue,
    ],
  },
  {
    space: 'oklab',
    mode: 'oklab',
    label: 'OKLab',
    channels: [unit('l', 'Lightness'), open('a', 'a axis', 0.5), open('b', 'b axis', 0.5)],
  },
  {
    space: 'oklch',
    mode: 'oklch',
    label: 'OKLCH',
    channels: [
      unit('l', 'Lightness'),
      { key: 'c', label: 'Chroma', min: 0, max: 0.5, step: 0.001, scale: 1 },
      hue,
    ],
  },
  {
    space: 'xyz-d65',
    mode: 'xyz65',
    label: 'XYZ D65',
    channels: [open('x', 'X', 1), open('y', 'Y', 1), open('z', 'Z', 1)],
  },
  {
    space: 'xyz-d50',
    mode: 'xyz50',
    label: 'XYZ D50',
    channels: [open('x', 'X', 1), open('y', 'Y', 1), open('z', 'Z', 1)],
  },
];

const bySpace = new Map(DEFINITIONS.map((definition) => [definition.space, definition]));
const byMode = new Map(DEFINITIONS.map((definition) => [definition.mode, definition]));

export function spaceDefinition(space: string): SpaceDefinition | undefined {
  return bySpace.get(space);
}

export const authoredSpaces = (): readonly SpaceDefinition[] => DEFINITIONS;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A DTCG color object, or `null` for an alias, a string, or anything else. */
export function readDtcgColor(value: JsonValue | undefined): DtcgColor | null {
  if (!isObject(value)) return null;
  const { colorSpace, components, alpha, hex } = value;
  if (typeof colorSpace !== 'string' || bySpace.get(colorSpace) === undefined) return null;
  if (!Array.isArray(components) || components.length !== 3) return null;
  const parts = components.map((part) => (part === 'none' ? 'none' : part));
  if (parts.some((part) => part !== 'none' && typeof part !== 'number')) return null;
  const color: DtcgColor = { colorSpace, components: parts as DtcgColor['components'] };
  if (typeof alpha === 'number') color.alpha = alpha;
  if (typeof hex === 'string') color.hex = hex;
  return color;
}

export const colorAlpha = (color: DtcgColor): number => color.alpha ?? 1;

/** The Culori color for an authored value (a derived view; `none` reads as 0). */
export function toCulori(color: DtcgColor): Color {
  const definition = bySpace.get(color.colorSpace)!;
  const [first, second, third] = definition.channels;
  const read = (index: number, channel: ChannelDefinition): number => {
    const part = color.components[index];
    return (typeof part === 'number' ? part : 0) / channel.scale;
  };
  return {
    mode: definition.mode,
    [first.key]: read(0, first),
    [second.key]: read(1, second),
    [third.key]: read(2, third),
    alpha: colorAlpha(color),
  } as unknown as Color;
}

const toOklchMode = converter('oklch');

export type OklchValue = { l: number; c: number; h: number; alpha: number };

/** OKLCH coordinates for any Culori color; an achromatic hue reads as 0. */
export function oklchOf(color: Color): OklchValue {
  const converted = toOklchMode(color);
  return {
    l: converted.l,
    c: converted.c,
    h: converted.h ?? 0,
    alpha: converted.alpha ?? 1,
  };
}

export const authoredOklch = (color: DtcgColor): OklchValue => oklchOf(toCulori(color));

/** The explicit source-preserving info for a color: is it inside sRGB and inside Display-P3? */
export type GamutInfo = { srgb: boolean; displayP3: boolean };

export function gamutInfo(color: DtcgColor): GamutInfo {
  const { l, c, h } = authoredOklch(color);
  return {
    srgb: inOutputGamut({ l, c, h }, 'srgb'),
    displayP3: inOutputGamut({ l, c, h }, 'display-p3'),
  };
}

export function gamutSummary(info: GamutInfo): string {
  if (info.srgb) return 'Inside sRGB and Display P3';
  if (info.displayP3) return 'Outside sRGB, inside Display P3';
  return 'Outside sRGB and Display P3';
}

const roundTo = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** The DTCG color for an OKLCH value, with the stated rounding. */
export function oklchColor(value: OklchValue): DtcgColor {
  const color: DtcgColor = {
    colorSpace: 'oklch',
    components: [roundTo(value.l, 5), roundTo(value.c, 5), roundTo(value.h, 3)],
  };
  if (value.alpha !== 1) color.alpha = roundTo(value.alpha, 4);
  return color;
}

/** A DTCG value the editor can write, as plain JSON. */
export function colorToJson(color: DtcgColor): JsonObject {
  const json: JsonObject = { colorSpace: color.colorSpace, components: [...color.components] };
  if (color.alpha !== undefined) json['alpha'] = color.alpha;
  if (color.hex !== undefined) json['hex'] = color.hex;
  return json;
}

/** OKLCH text such as `oklch(0.5 0.22 270 / 0.4)`, always labeled OKLCH. */
export function oklchText(value: OklchValue): string {
  const base = `oklch(${roundTo(value.l, 5)} ${roundTo(value.c, 5)} ${roundTo(value.h, 3)}`;
  return value.alpha === 1 ? `${base})` : `${base} / ${roundTo(value.alpha, 4)})`;
}

/** The authored value in its own space as CSS text. */
export function authoredText(color: DtcgColor): string {
  return formatCss(toCulori(color)) ?? '';
}

/** Replace one channel; the authored space and alpha are kept. */
export function withChannel(color: DtcgColor, index: 0 | 1 | 2, value: number): DtcgColor {
  const components = [...color.components];
  components[index] = value;
  const { hex: _hex, ...rest } = color;
  return { ...rest, components };
}

export function withAlpha(color: DtcgColor, alpha: number): DtcgColor {
  const next: DtcgColor = { ...color, alpha };
  if (alpha === 1) delete next.alpha;
  delete next.hex;
  return next;
}

/** An authored value in another space, as an explicit conversion the caller asked for. */
export function convertTo(color: DtcgColor, space: string): DtcgColor | null {
  const definition = bySpace.get(space);
  if (definition === undefined) return null;
  const converted = converter(definition.mode as 'rgb')(toCulori(color)) as unknown as Record<
    string,
    number | undefined
  >;
  const components = definition.channels.map((channel) =>
    roundTo((converted[channel.key] ?? 0) * channel.scale, 6),
  ) as DtcgColor['components'];
  const alpha = colorAlpha(color);
  return alpha === 1 ? { colorSpace: space, components } : { colorSpace: space, components, alpha };
}

export type ParsedColorText = { ok: true; color: DtcgColor } | { ok: false; message: string };

/**
 * Text such as `#3366ff`, `oklch(0.5 0.2 270)` or `color(display-p3 1 0 0)` becomes an
 * authored value in the space the text names. Reading text never changes the space silently:
 * the space is the one the user typed.
 */
export function parseColorText(text: string): ParsedColorText {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Enter a color.' };
  if (/var\(|calc\(|color-mix\(|light-dark\(|from\s/i.test(trimmed)) {
    return { ok: false, message: 'Enter a literal color, not a reference or a computed one.' };
  }
  const parsed = parse(trimmed);
  if (parsed === undefined) {
    return {
      ok: false,
      message: 'Not a color. Try #3366ff, oklch(0.5 0.2 270) or color(display-p3 1 0 0).',
    };
  }
  const definition = byMode.get(parsed.mode);
  if (definition === undefined)
    return { ok: false, message: `The ${parsed.mode} space is not supported.` };
  const channels = parsed as unknown as Record<string, number | undefined>;
  const components = definition.channels.map((channel) =>
    roundTo((channels[channel.key] ?? 0) * channel.scale, 6),
  ) as DtcgColor['components'];
  const color: DtcgColor = { colorSpace: definition.space, components };
  if (parsed.alpha !== undefined && parsed.alpha !== 1) color.alpha = roundTo(parsed.alpha, 4);
  if (trimmed.startsWith('#') && definition.space === 'srgb') color.hex = trimmed.toLowerCase();
  return { ok: true, color };
}

/** The color composited over an opaque background, as an sRGB CSS string. */
export function compositeOver(foreground: DtcgColor, background: DtcgColor): string {
  const top = converter('rgb')(toCulori(foreground));
  const bottom = converter('rgb')(toCulori(background));
  const alpha = colorAlpha(foreground);
  const mix = (a: number, b: number): number => a * alpha + b * (1 - alpha);
  return (
    formatCss({
      mode: 'rgb',
      r: mix(top.r, bottom.r),
      g: mix(top.g, bottom.g),
      b: mix(top.b, bottom.b),
    }) ?? ''
  );
}

/** Whether two authored values are the same authored value. */
export function sameColor(left: DtcgColor | null, right: DtcgColor | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.colorSpace === right.colorSpace &&
    colorAlpha(left) === colorAlpha(right) &&
    left.components.every((part, index) => part === right.components[index])
  );
}
