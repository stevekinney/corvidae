/**
 * The A2UI v0.9.1 basic catalog's 14 client functions, and the resolution of
 * the dynamic values that call them.
 *
 * A dynamic value is a literal, a data binding (`{ path }`), or a function
 * call (`{ call, args }`). Resolving one reads the data model, so a caller
 * that resolves inside a Svelte `$derived` re-runs as the model changes.
 * Nothing here evaluates markup or script: `formatString` has its own small
 * expression grammar, and `openUrl` opens only `http:` and `https:` URLs.
 */
import { resolvePath } from './data-model.svelte.ts';
import type { A2uiJsonValue } from './types.ts';

/** What resolving a dynamic value can read and report. */
export type A2uiEvaluationContext = {
  /** Reads the data model by JSON Pointer. */
  readonly read: (pointer: string) => A2uiJsonValue | undefined;
  /** The scope relative paths resolve against: `''` at the root, an item's pointer in a template. */
  readonly scope: string;
  readonly locale?: string | undefined;
  /** Hears a function that failed or does not exist. */
  readonly report: (message: string) => void;
  /** Opens a URL in a new browsing context; `window.open` when omitted. */
  readonly openUrl?: ((url: string) => void) | undefined;
  /** What a relative URL resolves against; `window.location.href` when omitted. */
  readonly baseUrl?: string | undefined;
};

/** The names of the basic catalog's client functions. */
export const A2UI_BASIC_FUNCTIONS = [
  'formatString',
  'required',
  'regex',
  'length',
  'numeric',
  'email',
  'formatNumber',
  'formatCurrency',
  'formatDate',
  'pluralize',
  'openUrl',
  'and',
  'or',
  'not',
] as const;

type Arguments = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBinding(value: Record<string, unknown>): value is { path: string } {
  return typeof value['path'] === 'string' && Object.keys(value).length === 1;
}

function isCall(value: Record<string, unknown>): value is { call: string; args?: unknown } {
  return typeof value['call'] === 'string';
}

/** Resolves a literal, a data binding, or a function call against the data model. */
export function resolveDynamic(value: unknown, context: A2uiEvaluationContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveDynamic(entry, context));
  if (!isRecord(value)) return value;
  if (isBinding(value)) return context.read(resolvePath(value.path, context.scope));
  if (isCall(value)) return callFunction(value.call, value.args, context);
  return value;
}

/** A value as text: `''` for null and undefined, JSON for objects and arrays. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : toNumber(value);
}

/** Calls a basic-catalog function with its arguments resolved. */
export function callFunction(
  name: string,
  rawArgs: unknown,
  context: A2uiEvaluationContext,
): unknown {
  const args: Arguments = {};
  if (isRecord(rawArgs)) {
    for (const [key, value] of Object.entries(rawArgs)) args[key] = resolveDynamic(value, context);
  }
  switch (name) {
    case 'formatString':
      return interpolate(stringify(args['value']), context);
    case 'required':
      return required(args['value']);
    case 'regex':
      return regex(args['value'], args['pattern'], context);
    case 'length':
      return length(args['value'], args['min'], args['max']);
    case 'numeric':
      return numeric(args['value'], args['min'], args['max']);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringify(args['value']));
    case 'formatNumber':
      return formatNumber(args, context.locale, undefined);
    case 'formatCurrency':
      return formatNumber(args, context.locale, stringify(args['currency']));
    case 'formatDate':
      return formatDate(args['value'], stringify(args['format']), context.locale);
    case 'pluralize':
      return pluralize(args, context.locale);
    case 'openUrl':
      openUrl(stringify(args['url']), context);
      return undefined;
    case 'and':
      return Array.isArray(args['values']) && args['values'].every((entry) => entry === true);
    case 'or':
      return Array.isArray(args['values']) && args['values'].some((entry) => entry === true);
    case 'not':
      return args['value'] !== true;
    default:
      context.report(`the basic catalog has no function "${name}"`);
      return undefined;
  }
}

function required(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

function regex(value: unknown, pattern: unknown, context: A2uiEvaluationContext): boolean {
  try {
    return new RegExp(stringify(pattern)).test(stringify(value));
  } catch {
    context.report(`regex: "${stringify(pattern)}" is not a valid pattern`);
    return false;
  }
}

function length(value: unknown, min: unknown, max: unknown): boolean {
  const size = stringify(value).length;
  const lower = optionalNumber(min);
  const upper = optionalNumber(max);
  return (lower === undefined || size >= lower) && (upper === undefined || size <= upper);
}

function numeric(value: unknown, min: unknown, max: unknown): boolean {
  const parsed = toNumber(value);
  if (parsed === undefined) return false;
  const lower = optionalNumber(min);
  const upper = optionalNumber(max);
  return (lower === undefined || parsed >= lower) && (upper === undefined || parsed <= upper);
}

function formatNumber(
  args: Arguments,
  locale: string | undefined,
  currency: string | undefined,
): string {
  const value = toNumber(args['value']);
  if (value === undefined) return '';
  const decimals = optionalNumber(args['decimals']);
  const options: Intl.NumberFormatOptions = {
    useGrouping: args['grouping'] !== false,
    ...(decimals === undefined
      ? {}
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    ...(currency === undefined ? {} : { style: 'currency', currency }),
  };
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return String(value);
  }
}

function pluralize(args: Arguments, locale: string | undefined): string {
  const value = toNumber(args['value']) ?? 0;
  const category = new Intl.PluralRules(locale).select(value);
  const chosen = args[category];
  return stringify(chosen === undefined || chosen === null ? args['other'] : chosen);
}

function openUrl(url: string, context: A2uiEvaluationContext): void {
  let resolved: URL;
  try {
    resolved = new URL(url, context.baseUrl ?? globalThis.location?.href);
  } catch {
    context.report(`openUrl: "${url}" is not a URL`);
    return;
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    context.report(`openUrl: only http and https URLs open, not "${resolved.protocol}"`);
    return;
  }
  if (context.openUrl !== undefined) context.openUrl(resolved.href);
  else globalThis.open?.(resolved.href, '_blank', 'noopener,noreferrer');
}

// ── formatDate ──────────────────────────────────────────────────────

const DATE_TOKEN = /'[^']*'|y{4}|y{2}|M{1,4}|d{1,2}|E{1,4}|H{1,2}|h{1,2}|m{1,2}|s{1,2}|a/g;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function dateName(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * A value as a date. A date-only string (`YYYY-MM-DD`) is a calendar date, so
 * it is read as local midnight; `new Date` would read it as UTC midnight and
 * show the previous day west of Greenwich.
 */
function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly !== null) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
    return new Date(value);
  }
  if (typeof value === 'number') return new Date(value);
  return undefined;
}

/** Formats a date with a Unicode TR35 pattern (the subset the basic catalog documents). */
export function formatDate(value: unknown, pattern: string, locale?: string): string {
  const date = toDate(value);
  if (date === undefined || Number.isNaN(date.getTime())) return '';
  return pattern.replace(DATE_TOKEN, (token) => {
    if (token.startsWith("'")) return token.slice(1, -1);
    const hours = date.getHours();
    switch (token) {
      case 'yyyy':
        return String(date.getFullYear());
      case 'yy':
        return pad(date.getFullYear() % 100);
      case 'MMMM':
        return dateName(date, locale, { month: 'long' });
      case 'MMM':
        return dateName(date, locale, { month: 'short' });
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'dd':
        return pad(date.getDate());
      case 'd':
        return String(date.getDate());
      case 'EEEE':
        return dateName(date, locale, { weekday: 'long' });
      case 'E':
      case 'EE':
      case 'EEE':
        return dateName(date, locale, { weekday: 'short' });
      case 'HH':
        return pad(hours);
      case 'H':
        return String(hours);
      case 'hh':
        return pad(hours % 12 === 0 ? 12 : hours % 12);
      case 'h':
        return String(hours % 12 === 0 ? 12 : hours % 12);
      case 'mm':
        return pad(date.getMinutes());
      case 'm':
        return String(date.getMinutes());
      case 'ss':
        return pad(date.getSeconds());
      case 's':
        return String(date.getSeconds());
      case 'a':
        return hours < 12 ? 'AM' : 'PM';
      default:
        return token;
    }
  });
}

// ── formatString ────────────────────────────────────────────────────

/**
 * Interpolates `${expression}` blocks into a template. An expression is a
 * literal (a quoted string, a number, `true`, `false`, or `null`), a data path
 * (absolute or relative), a function call with named arguments
 * (`name(argument: value, ...)`), or a nested `${...}`. `\${` is a literal `${`.
 */
export function interpolate(template: string, context: A2uiEvaluationContext): string {
  let output = '';
  let index = 0;
  while (index < template.length) {
    if (template.startsWith('\\${', index)) {
      output += '${';
      index += 3;
      continue;
    }
    if (template.startsWith('${', index)) {
      const parser = new ExpressionParser(template, index + 2, context);
      try {
        const value = parser.expression();
        parser.expect('}');
        output += stringify(value);
        index = parser.position;
      } catch (error: unknown) {
        context.report(`formatString: ${error instanceof Error ? error.message : String(error)}`);
        output += template.slice(index);
        break;
      }
      continue;
    }
    output += template[index];
    index += 1;
  }
  return output;
}

class ExpressionParser {
  position: number;

  constructor(
    private readonly source: string,
    start: number,
    private readonly context: A2uiEvaluationContext,
  ) {
    this.position = start;
  }

  private skipSpace(): void {
    while (/\s/.test(this.source[this.position] ?? '')) this.position += 1;
  }

  expect(character: string): void {
    this.skipSpace();
    if (this.source[this.position] !== character) {
      throw new Error(`expected "${character}" at ${this.position}`);
    }
    this.position += 1;
  }

  expression(): unknown {
    this.skipSpace();
    const rest = this.source.slice(this.position);
    if (rest.startsWith('${')) {
      this.position += 2;
      const value = this.expression();
      this.expect('}');
      return value;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      const end = this.source.indexOf(quote, this.position + 1);
      if (end === -1) throw new Error('unterminated string');
      const value = this.source.slice(this.position + 1, end);
      this.position = end + 1;
      return value;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(rest);
    if (number !== null) {
      this.position += number[0].length;
      return Number(number[0]);
    }
    const word = /^[A-Za-z_][\w]*/.exec(rest);
    if (word !== null && this.source[this.position + word[0].length] === '(') {
      this.position += word[0].length + 1;
      return this.call(word[0]);
    }
    for (const [keyword, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (word?.[0] === keyword) {
        this.position += keyword.length;
        return value;
      }
    }
    const path = /^[^\s}),]+/.exec(rest);
    if (path === null) throw new Error(`expected an expression at ${this.position}`);
    this.position += path[0].length;
    return this.context.read(resolvePath(path[0], this.context.scope));
  }

  private call(name: string): unknown {
    const args: Arguments = {};
    this.skipSpace();
    if (this.source[this.position] !== ')') {
      for (;;) {
        this.skipSpace();
        const key = /^[A-Za-z_]\w*/.exec(this.source.slice(this.position));
        if (key === null) throw new Error(`expected an argument name at ${this.position}`);
        this.position += key[0].length;
        this.expect(':');
        args[key[0]] = this.expression();
        this.skipSpace();
        if (this.source[this.position] === ',') {
          this.position += 1;
          continue;
        }
        break;
      }
    }
    this.expect(')');
    // The arguments are already values, so they pass through resolution unchanged.
    return callFunction(name, args, this.context);
  }
}
