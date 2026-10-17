/**
 * Evaluates the small CSS color grammar the corpus uses for DERIVED colors --
 * a `cssRecipe` that computes one token from another -- into a DTCG color
 * value, so the generator can materialize each theme's `$value` from the one
 * recipe instead of an author copying a hand-computed number into every theme
 * document.
 *
 * Supported forms, which are exactly the shapes the corpus writes:
 *
 * - `var(--cinder-x)`, resolved through the caller's lookup
 * - `oklch(L% C H)` / `oklch(L C H / A)` literals and `transparent`
 * - `color-mix(in oklch|oklab, A [p%], B [p%])`, with premultiplied alpha and
 *   shorter-arc hue interpolation, as CSS Color 5 specifies
 * - `oklch(from X <l> <c> <h> [/ <alpha>])`, where each channel is a keyword
 *   (`l`, `c`, `h`, `alpha`), a number, `calc(<keyword> ± n)`, or
 *   `min(...)`/`max(...)` of those
 *
 * Anything else returns `undefined`: the caller leaves that token's `$value`
 * as authored rather than guessing.
 */

import type { DesignToken } from '../../src/tokens/runtime/types.ts';

export type Oklch = { l: number; c: number; h: number | undefined; alpha: number };

/** Looks up a custom property's current value as OKLCH, or `undefined` when it is not a color. */
export type PropertyLookup = (property: string) => Oklch | undefined;

/** Called for every `color-mix()` evaluated, with its resolved operands. */
export type MixObserver = (space: 'oklch' | 'oklab', first: Oklch, second: Oklch) => void;

type Cursor = { text: string; index: number };

const HUE_EPSILON = 1e-6;

function skipSpace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index]!)) {
    cursor.index += 1;
  }
}

function consume(cursor: Cursor, token: string): boolean {
  skipSpace(cursor);
  if (cursor.text.startsWith(token, cursor.index)) {
    cursor.index += token.length;
    return true;
  }
  return false;
}

function expect(cursor: Cursor, token: string): void {
  if (!consume(cursor, token)) throw new RecipeSyntaxError(`expected "${token}"`, cursor);
}

class RecipeSyntaxError extends Error {
  constructor(message: string, cursor: Cursor) {
    super(`${message} at ${cursor.index} in "${cursor.text}"`);
  }
}

function readWord(cursor: Cursor): string {
  skipSpace(cursor);
  const match = /^[a-zA-Z][\w-]*/.exec(cursor.text.slice(cursor.index));
  if (!match) throw new RecipeSyntaxError('expected an identifier', cursor);
  cursor.index += match[0].length;
  return match[0];
}

function readNumber(cursor: Cursor): { value: number; percent: boolean } {
  skipSpace(cursor);
  const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(%?)/.exec(cursor.text.slice(cursor.index));
  if (!match) throw new RecipeSyntaxError('expected a number', cursor);
  cursor.index += match[0].length;
  return { value: Number.parseFloat(match[0]), percent: match[1] === '%' };
}

function peekIsNumber(cursor: Cursor): boolean {
  skipSpace(cursor);
  return /^[-+]?(?:\d|\.\d)/.test(cursor.text.slice(cursor.index));
}

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function oklabOf(color: Oklch): { l: number; a: number; b: number } {
  const radians = ((color.h ?? 0) * Math.PI) / 180;
  return { l: color.l, a: color.c * Math.cos(radians), b: color.c * Math.sin(radians) };
}

function oklchOfLab(l: number, a: number, b: number, alpha: number): Oklch {
  const c = Math.hypot(a, b);
  const h = c < HUE_EPSILON ? undefined : normalizeHue((Math.atan2(b, a) * 180) / Math.PI);
  return { l, c, h, alpha };
}

/** `color-mix()` per CSS Color 5: normalized weights, premultiplied alpha, shorter-arc hue. */
export function mixColors(
  space: 'oklch' | 'oklab',
  first: Oklch,
  second: Oklch,
  firstWeight: number | undefined,
  secondWeight: number | undefined,
): Oklch {
  let p1 = firstWeight;
  let p2 = secondWeight;
  if (p1 === undefined && p2 === undefined) p1 = p2 = 0.5;
  else if (p1 === undefined) p1 = 1 - p2!;
  else if (p2 === undefined) p2 = 1 - p1;
  const sum = p1 + p2!;
  if (sum <= 0) throw new Error('color-mix weights sum to zero');
  const w1 = p1 / sum;
  const w2 = p2! / sum;
  const alphaMultiplier = Math.min(sum, 1);

  const alpha = first.alpha * w1 + second.alpha * w2;
  const premultiplied = (one: number, two: number): number =>
    alpha === 0 ? 0 : (one * first.alpha * w1 + two * second.alpha * w2) / alpha;

  if (space === 'oklab') {
    const a = oklabOf(first);
    const b = oklabOf(second);
    return oklchOfLab(
      premultiplied(a.l, b.l),
      premultiplied(a.a, b.a),
      premultiplied(a.b, b.b),
      alpha * alphaMultiplier,
    );
  }

  // A missing hue (`none`, as `transparent` carries) takes the other color's
  // hue. An explicit hue on an achromatic color is NOT missing: browsers
  // interpolate it literally (Chromium computes
  // `color-mix(in oklch, oklch(28% 0.045 245), oklch(100% 0 0) 2.5%)` at hue
  // 247.875), and the materialized value has to match what renders.
  const firstHue = first.h;
  const secondHue = second.h;
  let h: number | undefined;
  if (firstHue === undefined) h = secondHue;
  else if (secondHue === undefined) h = firstHue;
  else {
    let delta = secondHue - firstHue;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    h = normalizeHue(firstHue + delta * w2);
  }
  return {
    l: premultiplied(first.l, second.l),
    c: premultiplied(first.c, second.c),
    h,
    alpha: alpha * alphaMultiplier,
  };
}

type Channels = { l: number; c: number; h: number; alpha: number };

function readChannel(cursor: Cursor, channels: Channels): number {
  skipSpace(cursor);
  if (peekIsNumber(cursor)) {
    const { value, percent } = readNumber(cursor);
    return percent ? value / 100 : value;
  }
  const word = readWord(cursor);
  if (word === 'calc') {
    expect(cursor, '(');
    let total = readChannel(cursor, channels);
    for (;;) {
      if (consume(cursor, ')')) return total;
      if (consume(cursor, '+')) total += readChannel(cursor, channels);
      else if (consume(cursor, '-')) total -= readChannel(cursor, channels);
      else throw new RecipeSyntaxError('expected "+", "-", or ")" in calc()', cursor);
    }
  }
  if (word === 'min' || word === 'max') {
    expect(cursor, '(');
    const values = [readChannel(cursor, channels)];
    while (consume(cursor, ',')) values.push(readChannel(cursor, channels));
    expect(cursor, ')');
    return word === 'min' ? Math.min(...values) : Math.max(...values);
  }
  if (word in channels) return channels[word as keyof Channels];
  throw new RecipeSyntaxError(`unknown channel keyword "${word}"`, cursor);
}

function readColor(cursor: Cursor, lookup: PropertyLookup, observe?: MixObserver): Oklch {
  skipSpace(cursor);
  const word = readWord(cursor);
  if (word === 'transparent') return { l: 0, c: 0, h: undefined, alpha: 0 };
  if (word === 'var') {
    expect(cursor, '(');
    skipSpace(cursor);
    const match = /^--[\w-]+/.exec(cursor.text.slice(cursor.index));
    if (!match) throw new RecipeSyntaxError('expected a custom property', cursor);
    cursor.index += match[0].length;
    expect(cursor, ')');
    const value = lookup(match[0]);
    if (!value) throw new Error(`"${match[0]}" does not resolve to a color`);
    return value;
  }
  if (word === 'color-mix') {
    expect(cursor, '(');
    expect(cursor, 'in');
    const space = readWord(cursor);
    if (space !== 'oklch' && space !== 'oklab') {
      throw new RecipeSyntaxError(`unsupported color-mix space "${space}"`, cursor);
    }
    expect(cursor, ',');
    const first = readColor(cursor, lookup, observe);
    const firstWeight = peekIsNumber(cursor) ? readNumber(cursor).value / 100 : undefined;
    expect(cursor, ',');
    const second = readColor(cursor, lookup, observe);
    const secondWeight = peekIsNumber(cursor) ? readNumber(cursor).value / 100 : undefined;
    expect(cursor, ')');
    observe?.(space, first, second);
    return mixColors(space, first, second, firstWeight, secondWeight);
  }
  if (word === 'oklch') {
    expect(cursor, '(');
    skipSpace(cursor);
    const from = /^from\s/.exec(cursor.text.slice(cursor.index));
    if (from) {
      cursor.index += from[0].length;
      const origin = readColor(cursor, lookup, observe);
      const channels: Channels = {
        l: origin.l,
        c: origin.c,
        h: origin.h ?? 0,
        alpha: origin.alpha,
      };
      const l = readChannel(cursor, channels);
      const c = readChannel(cursor, channels);
      const h = readChannel(cursor, channels);
      const alpha = consume(cursor, '/') ? readChannel(cursor, channels) : origin.alpha;
      expect(cursor, ')');
      return { l, c, h: origin.h === undefined && c < HUE_EPSILON ? undefined : h, alpha };
    }
    const l = readNumber(cursor);
    const c = readNumber(cursor);
    // `none` is a missing hue: it takes the other operand's hue in a mix.
    const h = consume(cursor, 'none') ? undefined : readNumber(cursor).value;
    let alpha = 1;
    if (consume(cursor, '/')) {
      const parsed = readNumber(cursor);
      alpha = parsed.percent ? parsed.value / 100 : parsed.value;
    }
    expect(cursor, ')');
    return { l: l.percent ? l.value / 100 : l.value, c: c.value, h, alpha };
  }
  throw new RecipeSyntaxError(`unsupported color function "${word}"`, cursor);
}

/** Evaluates a recipe, or returns `undefined` when it uses anything outside the supported grammar. */
export function evaluateRecipe(
  recipe: string,
  lookup: PropertyLookup,
  observe?: MixObserver,
): Oklch | undefined {
  const cursor: Cursor = { text: recipe, index: 0 };
  try {
    const color = readColor(cursor, lookup, observe);
    skipSpace(cursor);
    return cursor.index === recipe.length ? color : undefined;
  } catch (error) {
    if (error instanceof RecipeSyntaxError) return undefined;
    throw error;
  }
}

/** The custom properties a recipe reads through `var()`. */
export function recipeInputs(recipe: string): string[] {
  return [...recipe.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!);
}

/**
 * Splits a top-level `light-dark(a, b)` into its two arms, so a base recipe
 * that differs per theme can still be evaluated per theme.
 */
export function lightDarkArms(recipe: string): { light: string; dark: string } | undefined {
  const trimmed = recipe.trim();
  if (!trimmed.startsWith('light-dark(') || !trimmed.endsWith(')')) return undefined;
  const body = trimmed.slice('light-dark('.length, -1);
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      return { light: body.slice(0, index).trim(), dark: body.slice(index + 1).trim() };
    }
  }
  return undefined;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** Serializes an evaluated color as the DTCG `$value` the corpus stores. */
export function toDtcgColor(color: Oklch): NonNullable<DesignToken['$value']> {
  const value: { colorSpace: string; components: number[]; alpha?: number } = {
    colorSpace: 'oklch',
    components: [round(color.l, 5), round(color.c, 5), round(color.h ?? 0, 3)],
  };
  const alpha = round(color.alpha, 4);
  if (alpha !== 1) value.alpha = alpha;
  return value;
}
