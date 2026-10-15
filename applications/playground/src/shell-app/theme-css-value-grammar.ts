/**
 * The restricted CSS-only user-value grammar (COR-488). Every `cssOverrides` write goes
 * through `validateCssUserValue`: the generic editor's CSS-only field, a recipe's complete
 * override, and the four tokens that have no DTCG value. It is pure; the browser's
 * `CSS.supports` check is injected so tests can stand in for it.
 *
 * Stages, in order, each with a path-free message the caller prefixes with the token path:
 *
 * 1. Lexical rejection of anything that could end a declaration or reach a resource: escapes,
 *    comments, semicolons, braces, at-rules, angle brackets, `!`, control characters, resource
 *    functions, and unbalanced parentheses.
 * 2. A grammar over the contract the token's usage profile implies: typed serializations
 *    (lengths, times, plain numbers, colors), `auto` only for auto-capable sizes, percentages
 *    only for percentage-capable sizes, a positive `a / b` ratio only for aspect-ratio,
 *    `currentColor` only for colors, `var(--cinder-…)` to a public token with the same usage
 *    profile, finite `calc()`, and the color panel's safe function vocabulary. A function
 *    outside that list is rejected, whatever its arguments.
 * 3. `CSS.supports(property, value)` for every CSS property the token's profile records.
 */

import type { ProfileDefinition } from '@lostgradient/cinder/tokens/runtime';

export const MAX_CSS_VALUE_LENGTH = 4096;
const MAX_DEPTH = 8;
const MAX_TOKENS = 256;

export type CssValueKind = 'color' | 'dimension' | 'duration' | 'number' | 'other';

export type CssValueContract = {
  kind: CssValueKind;
  profileId: string | undefined;
  /** Every CSS property the token feeds; `CSS.supports` checks the value against each. */
  cssUsage: readonly string[];
  allowAuto: boolean;
  allowPercentage: boolean;
  ratio: boolean;
  allowCurrentColor: boolean;
};

export type SupportsFunction = (property: string, value: string) => boolean;

export type CssValueOptions = {
  /** `CSS.supports`, or `null` to skip the browser stage (only when no browser exists). */
  supports?: SupportsFunction | null;
  /** The usage profile id of a public custom property, or `undefined` when it is not public. */
  profileOfProperty?: (property: string) => string | undefined;
};

export type CssValueResult = { ok: true; value: string } | { ok: false; message: string };

const AUTO_PROFILES = new Set(['width', 'height']);
const PERCENT_PROFILES = new Set(['width', 'height', 'size']);

function kindOfType(type: string): CssValueKind {
  switch (type) {
    case 'color':
      return 'color';
    case 'dimension':
      return 'dimension';
    case 'duration':
      return 'duration';
    case 'number':
    case 'fontWeight':
      return 'number';
    default:
      return 'other';
  }
}

/** What a token's value may be, from its effective type and its usage profile. */
export function contractFor(
  type: string,
  profile: ProfileDefinition | undefined,
): CssValueContract {
  const id = profile?.id;
  return {
    kind: kindOfType(type),
    profileId: id,
    cssUsage: profile?.cssUsage ?? [],
    allowAuto: id !== undefined && AUTO_PROFILES.has(id),
    allowPercentage: id !== undefined && PERCENT_PROFILES.has(id),
    ratio: id === 'aspect-ratio',
    allowCurrentColor: type === 'color',
  };
}

/** `CSS.supports` when the platform has it. */
export function platformSupports(): SupportsFunction | null {
  const css = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } })
    .CSS;
  return typeof css?.supports === 'function'
    ? (property, value) => css.supports!(property, value)
    : null;
}

// --- stage 1: lexical ----------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const STRUCTURAL = /[;{}@<>!\\]/;
const RESOURCE =
  /(?:^|[^a-z0-9_-])(?:url|image|image-set|-webkit-image-set|cross-fade|-webkit-cross-fade|element|-moz-element|paint|attr|src|env|expression)\s*\(/i;

function lexicalProblem(value: string): string | undefined {
  if (value.length > MAX_CSS_VALUE_LENGTH) {
    return `Use ${MAX_CSS_VALUE_LENGTH} characters or fewer.`;
  }
  if (CONTROL.test(value)) return 'Control characters are not allowed.';
  if (/\/\*|\*\//.test(value)) return 'Comments are not allowed.';
  if (/[\\]/.test(value)) return 'Escapes are not allowed.';
  if (STRUCTURAL.test(value)) {
    return 'Semicolons, braces, at-rules, angle brackets and ! are not allowed.';
  }
  if (RESOURCE.test(value)) return 'Resource functions such as url() are not allowed.';
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth < 0) break;
  }
  return depth === 0 ? undefined : 'Parentheses must be balanced.';
}

// --- stage 2: tokens and grammar -----------------------------------------------------------

type Token =
  | { type: 'number'; value: number; unit: string }
  | { type: 'ident'; value: string }
  | { type: 'hex'; value: string }
  | { type: 'function'; name: string }
  | { type: 'open' | 'close' | 'comma' | 'slash' }
  | { type: 'operator'; value: '+' | '-' | '*' };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^-{0,2}[A-Za-z_][\w-]*/;
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/;
const UNIT = /^(?:%|[A-Za-z]+)/;

function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const character = rest.charAt(0);
    if (character === ' ' || character === '\t' || character === '\n') {
      index += 1;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) return 'The value is too long.';
    const previous = tokens.at(-1);
    const afterOperand =
      previous?.type === 'number' ||
      previous?.type === 'ident' ||
      previous?.type === 'hex' ||
      previous?.type === 'close';
    const signed = rest.match(NUMBER);
    // A sign belongs to a number where an operand may start, or after whitespace; it is an
    // operator only between operands (`a - b`).
    const isNumber =
      signed !== null &&
      (!afterOperand || !/^[+-]/.test(rest) || /\s/.test(text.charAt(index - 1)));
    if (signed !== null && isNumber) {
      const number = Number(signed[0]);
      if (!Number.isFinite(number)) return 'Numbers must be finite.';
      const unit = rest.slice(signed[0].length).match(UNIT)?.[0] ?? '';
      tokens.push({ type: 'number', value: number, unit });
      index += signed[0].length + unit.length;
      continue;
    }
    if (character === '#') {
      const hex = rest.match(HEX);
      if (hex === null) return 'That is not a valid hex color.';
      tokens.push({ type: 'hex', value: hex[0] });
      index += hex[0].length;
      continue;
    }
    const ident = rest.match(IDENT);
    if (ident !== null) {
      index += ident[0].length;
      if (text.charAt(index) === '(') {
        tokens.push({ type: 'function', name: ident[0].toLowerCase() });
        index += 1;
      } else tokens.push({ type: 'ident', value: ident[0] });
      continue;
    }
    index += 1;
    switch (character) {
      case '(':
        tokens.push({ type: 'open' });
        break;
      case ')':
        tokens.push({ type: 'close' });
        break;
      case ',':
        tokens.push({ type: 'comma' });
        break;
      case '/':
        tokens.push({ type: 'slash' });
        break;
      case '+':
      case '-':
      case '*':
        tokens.push({ type: 'operator', value: character });
        break;
      default:
        return `“${character}” is not allowed here.`;
    }
  }
  return tokens;
}

const LENGTH_UNITS = new Set([
  'px',
  'rem',
  'em',
  'ch',
  'vw',
  'vh',
  'dvh',
  'svh',
  'lvh',
  'vmin',
  'vmax',
]);
const TIME_UNITS = new Set(['ms', 's']);
const ANGLE_UNITS = new Set(['deg', 'turn', 'rad', 'grad']);

/** The color panel's safe vocabulary, plus `light-dark` (the shipped recipes use it). */
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
]);
const COLOR_WORDS = new Set([
  'none',
  'from',
  'in',
  'to',
  'srgb',
  'srgb-linear',
  'display-p3',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'xyz',
  'xyz-d50',
  'xyz-d65',
  'oklab',
  'oklch',
  'lab',
  'lch',
  'hsl',
  'hwb',
  'shorter',
  'longer',
  'increasing',
  'decreasing',
  'specified',
  'l',
  'a',
  'b',
  'c',
  'h',
  's',
  'w',
  'r',
  'g',
  'alpha',
  'transparent',
  'currentcolor',
]);

class Parser {
  position = 0;
  error: string | undefined;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly contract: CssValueContract,
    private readonly options: CssValueOptions,
  ) {}

  private fail(message: string): false {
    this.error ??= message;
    return false;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  atEnd(): boolean {
    return this.position >= this.tokens.length;
  }

  /** One term of the value; nested functions enter through `call`. */
  term(depth: number, inCalc: boolean, inColor: boolean): boolean {
    const token = this.peek();
    if (token === undefined) return this.fail('The value is incomplete.');
    this.position += 1;
    switch (token.type) {
      case 'number':
        return this.numeric(token, inColor);
      case 'hex':
        return this.contract.kind === 'color' || inColor
          ? true
          : this.fail('A hex color is only valid for a color token.');
      case 'ident':
        return this.word(token.value, inColor);
      case 'function':
        return this.call(token.name, depth, inCalc, inColor);
      case 'open':
        if (!inCalc) return this.fail('Parentheses are only allowed inside calc().');
        return this.sum(depth + 1, inCalc, inColor) && this.expect('close');
      default:
        return this.fail('That is not valid here.');
    }
  }

  private expect(type: Token['type']): boolean {
    if (this.peek()?.type !== type) return this.fail('The value is incomplete.');
    this.position += 1;
    return true;
  }

  private numeric(token: Extract<Token, { type: 'number' }>, inColor: boolean): boolean {
    const unit = token.unit.toLowerCase();
    if (unit === '') return true;
    if (unit === '%') {
      return this.contract.allowPercentage || inColor
        ? true
        : this.fail('A percentage is not valid for this token.');
    }
    if (inColor && ANGLE_UNITS.has(unit)) return true;
    if (LENGTH_UNITS.has(unit)) {
      return this.contract.kind === 'dimension'
        ? true
        : this.fail(`A ${unit} length is not valid for this token.`);
    }
    if (TIME_UNITS.has(unit)) {
      return this.contract.kind === 'duration'
        ? true
        : this.fail(`A ${unit} time is not valid for this token.`);
    }
    return this.fail(`The unit “${token.unit}” is not allowed.`);
  }

  private word(value: string, inColor: boolean): boolean {
    const lower = value.toLowerCase();
    if (lower === 'auto' && this.contract.allowAuto) return true;
    if (this.contract.kind === 'color' || inColor) {
      if (lower === 'currentcolor') {
        return this.contract.allowCurrentColor || inColor
          ? true
          : this.fail('currentColor is only valid for a color token.');
      }
      if (COLOR_WORDS.has(lower)) return true;
    }
    return this.fail(`“${value}” is not allowed here.`);
  }

  private call(name: string, depth: number, inCalc: boolean, inColor: boolean): boolean {
    if (depth >= MAX_DEPTH) return this.fail('The value is nested too deeply.');
    if (name === 'var') return this.variable();
    if (name === 'calc') {
      return this.sum(depth + 1, true, inColor) && this.expect('close');
    }
    if (COLOR_FUNCTIONS.has(name) && (this.contract.kind === 'color' || inColor)) {
      return this.arguments(depth + 1, inCalc);
    }
    return this.fail(`The function ${name}() is not allowed here.`);
  }

  private variable(): boolean {
    const token = this.peek();
    if (token?.type !== 'ident' || !/^--cinder-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token.value)) {
      return this.fail('var() may only name a public --cinder- property.');
    }
    this.position += 1;
    const profileOf = this.options.profileOfProperty;
    const target = profileOf?.(token.value);
    if (profileOf === undefined || target === undefined) {
      return this.fail(`${token.value} is not a public Cinder token.`);
    }
    if (target !== this.contract.profileId) {
      return this.fail(`${token.value} has a different usage contract (${target}).`);
    }
    return this.expect('close');
  }

  /** Color-function arguments: terms with `,` and `/` separators until the closing paren. */
  private arguments(depth: number, inCalc: boolean): boolean {
    for (;;) {
      const next = this.peek();
      if (next === undefined) return this.fail('The value is incomplete.');
      if (next.type === 'close') {
        this.position += 1;
        return true;
      }
      if (next.type === 'comma' || next.type === 'slash') {
        this.position += 1;
        continue;
      }
      if (next.type === 'operator') return this.fail('Arithmetic needs calc().');
      if (!this.term(depth, inCalc, true)) return false;
    }
  }

  /** `calc()` arithmetic: products joined by + and -. */
  private sum(depth: number, inCalc: boolean, inColor: boolean): boolean {
    if (!this.product(depth, inCalc, inColor)) return false;
    for (;;) {
      const next = this.peek();
      if (next?.type !== 'operator' || next.value === '*') return true;
      this.position += 1;
      if (!this.product(depth, inCalc, inColor)) return false;
    }
  }

  private product(depth: number, inCalc: boolean, inColor: boolean): boolean {
    if (!this.term(depth, inCalc, inColor)) return false;
    for (;;) {
      const next = this.peek();
      if (next?.type === 'operator' && next.value === '*') {
        this.position += 1;
      } else if (next?.type === 'slash') {
        this.position += 1;
        const divisor = this.peek();
        if (divisor?.type === 'number' && divisor.value === 0) {
          return this.fail('calc() cannot divide by zero.');
        }
      } else return true;
      if (!this.term(depth, inCalc, inColor)) return false;
    }
  }

  get message(): string | undefined {
    return this.error;
  }
}

function ratioProblem(tokens: readonly Token[]): string | undefined {
  const [left, slash, right, ...rest] = tokens;
  const positive = (token: Token | undefined) =>
    token?.type === 'number' && token.unit === '' && token.value > 0;
  if (!positive(left) || slash?.type !== 'slash' || !positive(right) || rest.length > 0) {
    return 'Write a ratio of two positive numbers, for example 16 / 9.';
  }
  return undefined;
}

function grammarProblem(
  text: string,
  contract: CssValueContract,
  options: CssValueOptions,
): string | undefined {
  const tokens = tokenize(text);
  if (typeof tokens === 'string') return tokens;
  if (contract.ratio) return ratioProblem(tokens);
  if (contract.kind === 'other') {
    return 'This token has no CSS-only value grammar.';
  }
  const [only] = tokens;
  if (
    (contract.kind === 'dimension' || contract.kind === 'duration') &&
    tokens.length === 1 &&
    only?.type === 'number' &&
    only.unit === '' &&
    only.value !== 0
  ) {
    return 'Add a unit, for example 4px or 200ms.';
  }
  const parser = new Parser(tokens, contract, options);
  const ok = parser.term(0, false, false);
  if (!ok) return parser.message ?? 'That is not a valid value.';
  return parser.atEnd() ? undefined : 'Use a single value.';
}

/**
 * Validate `text` for a token with `contract`. A rejected value has a message that names the
 * rule it broke; an accepted one is returned trimmed, ready to store.
 */
export function validateCssUserValue(
  text: string,
  contract: CssValueContract,
  options: CssValueOptions = {},
): CssValueResult {
  const value = text.trim();
  if (value === '') return { ok: false, message: 'Enter a value.' };
  const lexical = lexicalProblem(value);
  if (lexical !== undefined) return { ok: false, message: lexical };
  const grammar = grammarProblem(value, contract, options);
  if (grammar !== undefined) return { ok: false, message: grammar };
  const supports = options.supports === undefined ? platformSupports() : options.supports;
  if (supports !== null) {
    for (const property of contract.cssUsage) {
      if (!supports(property, value)) {
        return { ok: false, message: `“${value}” is not a valid ${property} value.` };
      }
    }
  }
  return { ok: true, value };
}
