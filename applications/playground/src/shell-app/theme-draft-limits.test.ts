import { describe, expect, it } from 'bun:test';

import {
  checkCssOverrideLimits,
  checkDocumentLimits,
  checkFileSize,
  THEME_DATA_LIMITS,
} from './theme-draft-limits.ts';
import { testBase } from './theme-draft-test-support.ts';
import type { JsonObject } from './theme-draft-types.ts';
import { applyEdit, createDraft } from './theme-draft.ts';
import { createEnvelope, parseThemeEnvelope } from './theme-envelope.ts';

const codes = (violations: { code: string }[]): string[] => violations.map((v) => v.code);

function tokens(count: number): JsonObject {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, { $value: 1 }]));
}

function nested(depth: number): JsonObject {
  let node: JsonObject = { leaf: { $value: 1 } };
  for (let level = 1; level < depth; level += 1) node = { g: node };
  return node;
}

describe('data limits: exact bound and bound+1', () => {
  it('file size is 1 MiB of UTF-8', () => {
    expect(checkFileSize('a'.repeat(THEME_DATA_LIMITS.fileBytes))).toEqual([]);
    expect(codes(checkFileSize('a'.repeat(THEME_DATA_LIMITS.fileBytes + 1)))).toEqual([
      'file-too-large',
    ]);
    // 3-byte characters are measured in bytes, not characters.
    expect(
      codes(checkFileSize('€'.repeat(Math.floor(THEME_DATA_LIMITS.fileBytes / 3) + 1))),
    ).toEqual(['file-too-large']);
  });

  it('bundles at most 64 documents', () => {
    const docs = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}.json`, {}]));
    expect(checkDocumentLimits(docs(64))).toEqual([]);
    expect(codes(checkDocumentLimits(docs(65)))).toEqual(['too-many-documents']);
  });

  it('admits 2,000 token records and refuses 2,001', () => {
    expect(checkDocumentLimits({ 'a.json': tokens(2000) })).toEqual([]);
    expect(codes(checkDocumentLimits({ 'a.json': tokens(2001) }))).toEqual([
      'too-many-token-records',
    ]);
  });

  it('admits nesting depth 32 and refuses 33', () => {
    expect(checkDocumentLimits({ 'a.json': nested(32) })).toEqual([]);
    expect(codes(checkDocumentLimits({ 'a.json': nested(33) }))).toContain('nesting-too-deep');
  });

  it('bounds the token path at 240 characters and each segment at 80', () => {
    const segment = 'a'.repeat(80);
    const path240 = [segment, segment, 'a'.repeat(78)]; // 80 + 1 + 80 + 1 + 78 = 240
    const build = (segments: string[]): JsonObject =>
      segments.reduceRight<JsonObject>((inner, key) => ({ [key]: inner }), { $value: 1 });
    expect(checkDocumentLimits({ 'a.json': build(path240) })).toEqual([]);
    expect(
      codes(checkDocumentLimits({ 'a.json': build([segment, segment, 'a'.repeat(79)]) })),
    ).toEqual(['path-too-long']);
    expect(codes(checkDocumentLimits({ 'a.json': build(['a'.repeat(81)]) }))).toEqual([
      'segment-too-long',
    ]);
  });

  it('bounds the document path at 240 characters', () => {
    expect(checkDocumentLimits({ ['d'.repeat(240)]: {} })).toEqual([]);
    expect(codes(checkDocumentLimits({ ['d'.repeat(241)]: {} }))).toEqual(['path-too-long']);
  });

  it('bounds a scalar string at 4 KiB, in bytes', () => {
    const doc = (value: string): JsonObject => ({ t: { $value: 1, $description: value } });
    expect(checkDocumentLimits({ 'a.json': doc('a'.repeat(4096)) })).toEqual([]);
    expect(codes(checkDocumentLimits({ 'a.json': doc('a'.repeat(4097)) }))).toEqual([
      'scalar-too-large',
    ]);
    expect(codes(checkDocumentLimits({ 'a.json': doc('€'.repeat(1366)) }))).toEqual([
      'scalar-too-large',
    ]);
  });

  it('applies the scalar and path bounds to CSS-only overrides', () => {
    const css = (value: string) => ({ 'a.b': { 'light/default': value } });
    expect(checkCssOverrideLimits(css('a'.repeat(4096)))).toEqual([]);
    expect(codes(checkCssOverrideLimits(css('a'.repeat(4097))))).toEqual(['scalar-too-large']);
  });
});

describe('limits at the edit and import boundary', () => {
  it('refuses an edit that crosses a limit and keeps the draft unchanged', () => {
    const draft = createDraft(createEnvelope('t', 'T', testBase()));
    const refused = applyEdit(draft, {
      kind: 'set-override',
      scope: 'light',
      path: 'x',
      node: { $value: 'a'.repeat(4097) },
    });
    expect(refused.ok).toBe(false);
    const admitted = applyEdit(draft, {
      kind: 'set-override',
      scope: 'light',
      path: 'x',
      node: { $value: 'a'.repeat(4096) },
    });
    expect(admitted.ok).toBe(true);
  });

  it('parses a valid envelope and names the limit that stopped an import', () => {
    const envelope = createEnvelope('t', 'T', testBase());
    expect(parseThemeEnvelope(JSON.stringify(envelope)).ok).toBe(true);
    const tooMany = { ...envelope, overrides: { ...envelope.overrides, shared: tokens(2001) } };
    const parsed = parseThemeEnvelope(JSON.stringify(tooMany));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('limits');
    expect(parseThemeEnvelope('{').ok).toBe(false);
    expect(parseThemeEnvelope('{"format":"other"}')).toMatchObject({
      ok: false,
      reason: 'unrecognized',
    });
  });
});
