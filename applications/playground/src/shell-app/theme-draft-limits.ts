/**
 * The data limits of the theme builder's input contract (COR-490). Every bound is inclusive:
 * the limit itself is admitted and one past it is refused. Nothing is truncated or raised.
 */

import type { JsonObject, JsonValue } from './theme-draft-types.ts';

export const THEME_DATA_LIMITS = {
  /** An input file, in UTF-8 bytes. */
  fileBytes: 1024 * 1024,
  documents: 64,
  tokenRecords: 2000,
  nestingDepth: 32,
  /** A normalized document or token path, in characters. */
  pathLength: 240,
  segmentLength: 80,
  /** A scalar string, in UTF-8 bytes. */
  scalarBytes: 4096,
  themes: 50,
  /** Total serialized local data, in bytes. */
  storageBytes: 50 * 1024 * 1024,
  historyTransactions: 200,
} as const;

export type LimitCode =
  | 'file-too-large'
  | 'too-many-documents'
  | 'too-many-token-records'
  | 'nesting-too-deep'
  | 'path-too-long'
  | 'segment-too-long'
  | 'scalar-too-large';

export type LimitViolation = { code: LimitCode; location: string; limit: number; actual: number };

const encoder = new TextEncoder();
export const utf8Length = (text: string): number => encoder.encode(text).length;

/** A DTCG token carries `$value`; a reference-only node carries `$ref` and counts too. */
const isTokenRecord = (node: JsonObject): boolean =>
  Object.hasOwn(node, '$value') || (Object.hasOwn(node, '$ref') && !Object.hasOwn(node, '$type'));

class Collector {
  readonly violations: LimitViolation[] = [];
  tokenRecords = 0;
  private readonly seen = new Set<string>();

  add(violation: LimitViolation): void {
    const key = `${violation.code}:${violation.location}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push(violation);
  }

  scalars(value: JsonValue, location: string): void {
    if (typeof value === 'string') {
      const actual = utf8Length(value);
      if (actual > THEME_DATA_LIMITS.scalarBytes) {
        this.add({
          code: 'scalar-too-large',
          location,
          limit: THEME_DATA_LIMITS.scalarBytes,
          actual,
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => this.scalars(item, location));
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach((item) => this.scalars(item, location));
    }
  }

  walk(node: JsonObject, segments: string[], location: string): void {
    if (segments.length > THEME_DATA_LIMITS.nestingDepth) {
      this.add({
        code: 'nesting-too-deep',
        location,
        limit: THEME_DATA_LIMITS.nestingDepth,
        actual: segments.length,
      });
      return;
    }
    if (segments.length > 0 && isTokenRecord(node)) this.tokenRecords += 1;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$')) {
        this.scalars(value, location);
        continue;
      }
      const next = [...segments, key];
      const path = next.join('.');
      if (Array.from(key).length > THEME_DATA_LIMITS.segmentLength) {
        this.add({
          code: 'segment-too-long',
          location: `${location}#${path}`,
          limit: THEME_DATA_LIMITS.segmentLength,
          actual: Array.from(key).length,
        });
      }
      if (Array.from(path).length > THEME_DATA_LIMITS.pathLength) {
        this.add({
          code: 'path-too-long',
          location: `${location}#${path}`,
          limit: THEME_DATA_LIMITS.pathLength,
          actual: Array.from(path).length,
        });
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this.walk(value, next, location);
      } else {
        this.scalars(value, location);
      }
    }
  }
}

/** Check a set of bundled documents (or override trees) against every structural limit. */
export function checkDocumentLimits(documents: Record<string, JsonValue>): LimitViolation[] {
  const collector = new Collector();
  const names = Object.keys(documents);
  if (names.length > THEME_DATA_LIMITS.documents) {
    collector.add({
      code: 'too-many-documents',
      location: 'documents',
      limit: THEME_DATA_LIMITS.documents,
      actual: names.length,
    });
  }
  for (const name of names) {
    if (Array.from(name).length > THEME_DATA_LIMITS.pathLength) {
      collector.add({
        code: 'path-too-long',
        location: name,
        limit: THEME_DATA_LIMITS.pathLength,
        actual: Array.from(name).length,
      });
    }
    const document = documents[name];
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      collector.walk(document, [], name);
    }
  }
  if (collector.tokenRecords > THEME_DATA_LIMITS.tokenRecords) {
    collector.add({
      code: 'too-many-token-records',
      location: 'documents',
      limit: THEME_DATA_LIMITS.tokenRecords,
      actual: collector.tokenRecords,
    });
  }
  return collector.violations;
}

export function checkFileSize(text: string): LimitViolation[] {
  const actual = utf8Length(text);
  return actual > THEME_DATA_LIMITS.fileBytes
    ? [{ code: 'file-too-large', location: 'file', limit: THEME_DATA_LIMITS.fileBytes, actual }]
    : [];
}

/** Scalar check for CSS-only override values, which live outside any DTCG tree. */
export function checkCssOverrideLimits(
  cssOverrides: Record<string, Partial<Record<string, string>>>,
): LimitViolation[] {
  const collector = new Collector();
  for (const [path, byContext] of Object.entries(cssOverrides)) {
    const segments = path.split('.');
    if (segments.some((segment) => Array.from(segment).length > THEME_DATA_LIMITS.segmentLength)) {
      collector.add({
        code: 'segment-too-long',
        location: path,
        limit: THEME_DATA_LIMITS.segmentLength,
        actual: Math.max(...segments.map((segment) => Array.from(segment).length)),
      });
    }
    if (Array.from(path).length > THEME_DATA_LIMITS.pathLength) {
      collector.add({
        code: 'path-too-long',
        location: path,
        limit: THEME_DATA_LIMITS.pathLength,
        actual: Array.from(path).length,
      });
    }
    for (const value of Object.values(byContext)) {
      if (value !== undefined) collector.scalars(value, path);
    }
  }
  return collector.violations;
}
