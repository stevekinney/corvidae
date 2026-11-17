/**
 * Round trip of all 13 DTCG types and all six contexts (COR-486): source metadata, aliases,
 * descriptions, deprecation and extensions survive the lossless envelope and the portable
 * per-context documents, and Source tokens never acquire CSS.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cinderThemeBase } from './theme-builder-base.ts';
import { THEME_CONTEXT_IDS, type JsonObject } from './theme-draft-types.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import { planExports, type ExportArtifact } from './theme-export-plan.ts';
import { takeExportSnapshot } from './theme-export-snapshot.ts';
import { preflightImport } from './theme-import-preflight.ts';
import { envelopeText, evaluator } from './theme-interchange-test-support.ts';

const FIXTURES = join(
  import.meta.dir,
  '../../../../components/cinder/scripts/tokens/fixtures/theme-builder',
);
const allTypes = JSON.parse(
  readFileSync(join(FIXTURES, 'all-types.tokens.json'), 'utf8'),
) as Record<string, unknown>;
const { $schema: _schema, ...specimen } = allTypes;

const colorFor = (value: number) => ({
  $type: 'color',
  $value: { colorSpace: 'srgb', components: [value, value, value] },
  $description: `value ${value}`,
  $extensions: { 'com.example.vendor': { scope: value } },
});
const overrides = {
  shared: specimen as JsonObject,
  light: { specimen: { color: { srgb: colorFor(0.1) } } },
  dark: { specimen: { color: { srgb: colorFor(0.2) } } },
  reduced: { specimen: { color: { srgb: colorFor(0.3) } } },
  forcedReduced: { specimen: { color: { srgb: colorFor(0.4) } } },
} as unknown as import('./theme-draft-types.ts').ThemeOverrides;

const envelope = {
  ...createEnvelope('roundtrip-1', 'Round trip', cinderThemeBase()),
  overrides,
};
const snapshot = await takeExportSnapshot(createDraft(envelope), evaluator);
const plan = planExports(snapshot, true);
const reimported = await preflightImport(
  envelopeText(envelope),
  'roundtrip.json',
  createEnvelope('open', 'Open', cinderThemeBase()),
);
const artifact = (kind: ExportArtifact['kind']) => plan.artifacts.find((a) => a.kind === kind)!;

describe('the lossless source envelope', () => {
  test('the all-types fixture validates in all six contexts', () => {
    expect(snapshot.sourceIsValid).toBe(true);
    expect(THEME_CONTEXT_IDS).toHaveLength(6);
  });

  test('re-imports with identical overrides: types, aliases, metadata, extensions', () => {
    expect(reimported.candidate?.kind).toBe('envelope');
    expect(reimported.candidate?.envelope.overrides).toEqual(overrides);
    const shared = reimported.candidate!.envelope.overrides.shared as Record<string, any>;
    expect(shared['specimen'].pointer.alias.$ref).toBe('#/specimen/dimension/rem');
    expect(shared['specimen'].extended.$extends).toBe('{specimen.dimension}');
    expect(shared['specimen'].metadata.old.$deprecated).toBe('Use specimen.number.one.');
    expect(shared['specimen'].metadata.old.$extensions).toEqual({
      'com.example.vendor': { anything: true },
    });
    expect(shared['specimen'].scale.$root.$value).toEqual({ value: 1, unit: 'rem' });
  });
});

describe('the portable documents', () => {
  const documents = plan.portable.documents;

  test('carry the specimen source unchanged in every context, aliases and extensions intact', () => {
    expect(documents.map((d) => d.context)).toEqual([...THEME_CONTEXT_IDS]);
    for (const { document } of documents) {
      const doc = document as Record<string, any>;
      expect(doc['specimen'].fontFamily).toEqual((specimen['specimen'] as any).fontFamily);
      expect(doc['specimen'].pointer.alias.$ref).toBe('#/specimen/dimension/rem');
      expect(doc['specimen'].extended.$extends).toBe('{specimen.dimension}');
      expect(doc['specimen'].metadata.old.$extensions).toEqual({
        'com.example.vendor': { anything: true },
      });
      expect(doc['specimen'].scale.$root.$value).toEqual({ value: 1, unit: 'rem' });
    }
  });

  test('differ by context exactly where the scopes override', () => {
    const value = (index: number) =>
      (documents[index]!.document as any).specimen.color.srgb.$value.components[0];
    // light: 0.1; dark: 0.2; reduced and forced-reduced motion layer after the theme.
    expect(value(0)).toBe(0.1);
    expect(value(3)).toBe(0.2);
    expect(value(1)).toBe(0.3);
    expect(value(2)).toBe(0.4);
    expect(value(4)).toBe(0.3);
    expect(value(5)).toBe(0.4);
  });

  test('cover all 13 DTCG types as source tokens', () => {
    const types = new Set<string>();
    const walk = (node: any, inherited: string | undefined): void => {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
      const type = typeof node.$type === 'string' ? node.$type : inherited;
      if ('$value' in node && type !== undefined) types.add(type);
      for (const [key, child] of Object.entries(node)) {
        if (!key.startsWith('$') || key === '$root') walk(child, type);
      }
    };
    walk((documents[0]!.document as any).specimen, undefined);
    expect([...types].toSorted()).toEqual(
      [
        'border',
        'color',
        'cubicBezier',
        'dimension',
        'duration',
        'fontFamily',
        'fontWeight',
        'gradient',
        'number',
        'shadow',
        'strokeStyle',
        'transition',
        'typography',
      ].toSorted(),
    );
  });

  test('Source tokens emit no CSS declarations', () => {
    const css = artifact('css');
    expect(css.available).toBe(true);
    expect(css.files[0]!.text).not.toContain('specimen');
    expect(plan.portable.sourceTokensIncluded).toBeGreaterThan(20);
  });
});
