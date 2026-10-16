/**
 * Export snapshot, gating, the four artifacts and the clipboard fallback (COR-486). Evaluating
 * and planning a real theme happens at module scope, untimed.
 */

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';
import { describe, expect, test } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope, parseThemeEnvelope } from './theme-envelope.ts';
import { copyOrDownload, downloadFile } from './theme-export-delivery.ts';
import { planExports, type ExportArtifact } from './theme-export-plan.ts';
import { snapshotIsCurrent, takeExportSnapshot } from './theme-export-snapshot.ts';
import { preflightImport } from './theme-import-preflight.ts';
import { editedEnvelope, evaluator } from './theme-interchange-test-support.ts';

const draft = createDraft(editedEnvelope());
const snapshot = await takeExportSnapshot(draft, evaluator);
const released = planExports(snapshot, true);
const held = planExports(snapshot, false);
const artifact = (plan: typeof released, kind: ExportArtifact['kind']): ExportArtifact =>
  plan.artifacts.find((a) => a.kind === kind)!;

const pristine = await takeExportSnapshot(
  createDraft(createEnvelope('plain', 'Plain', cinderThemeBase())),
  evaluator,
);

describe('the snapshot', () => {
  test('is the exact revision checked and goes stale when the draft moves on', () => {
    expect(snapshot.revision).toBe(draft.revision);
    expect(snapshot.sourceIsValid).toBe(true);
    expect(snapshot.baseIsCurrent).toBe(true);
    expect(snapshotIsCurrent(snapshot, draft)).toBe(true);
    expect(snapshotIsCurrent(snapshot, { ...draft, revision: draft.revision + 1 })).toBe(false);
    expect(snapshotIsCurrent(snapshot, null)).toBe(false);
  });
});

describe('the source envelope', () => {
  const source = artifact(released, 'source');

  test('is labeled Cinder Theme v1, not DTCG, and named by theme and short id', () => {
    expect(source.title).toContain('Cinder Theme v1');
    expect(source.description).toContain('not a standard DTCG document');
    expect(source.files[0]?.filename).toBe('edited-theme-theme-aa.cinder-theme.json');
    expect(source.caveat).toBeNull();
  });

  test('is lossless: it parses back to the identical envelope with aliases unflattened', () => {
    const parsed = parseThemeEnvelope(source.files[0]!.text);
    expect(parsed.ok && parsed.envelope).toEqual(snapshot.envelope);
    expect(source.files[0]!.text).toContain('"$value": "{radius.medium}"');
  });

  test('is available and labeled unvalidated for an invalid source', async () => {
    const broken = createDraft({
      ...snapshot.envelope,
      overrides: {
        ...snapshot.envelope.overrides,
        shared: { radius: { medium: { $type: 'dimension', $value: '{radius.nowhere}' } } },
      },
    });
    const invalid = await takeExportSnapshot(broken, evaluator);
    const plan = planExports(invalid, true);
    expect(artifact(plan, 'source').available).toBe(true);
    expect(artifact(plan, 'source').caveat).toBe('Unvalidated');
    expect(artifact(plan, 'css').available).toBe(false);
    expect(artifact(plan, 'portable-subset').available).toBe(false);
    expect(artifact(plan, 'report').available).toBe(true);
  });

  test('exports and re-imports to the identical draft state', async () => {
    const reimported = await preflightImport(source.files[0]!.text, 'r.json', pristine.envelope);
    expect(reimported.candidate?.kind).toBe('envelope');
    const { envelope } = reimported.candidate!;
    expect(envelope.overrides).toEqual(snapshot.envelope.overrides);
    expect(envelope.cssOverrides).toEqual(snapshot.envelope.cssOverrides);
    expect(envelope.name).toBe(snapshot.envelope.name);
    expect(envelope.base.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });
});

describe('gating', () => {
  test('needs-review and advisory items hold CSS and portable until acknowledged', () => {
    expect(held.acknowledgeable).toBeGreaterThan(0);
    expect(artifact(held, 'css').available).toBe(false);
    expect(artifact(held, 'css').blockedReason).toContain('acknowledgement');
    expect(artifact(held, 'source').available).toBe(true);
    expect(artifact(held, 'report').available).toBe(true);
  });

  test('an accessibility error blocks CSS and portable exports but not source or report', async () => {
    const bad = createDraft({
      ...snapshot.envelope,
      overrides: {
        ...snapshot.envelope.overrides,
        light: {
          text: {
            default: {
              $type: 'color',
              $value: { colorSpace: 'srgb', components: [0.95, 0.95, 0.95] },
            },
          },
        },
      },
    });
    const snap = await takeExportSnapshot(bad, evaluator);
    expect(snap.readiness).toBe('blocked-accessibility-errors');
    const plan = planExports(snap, true);
    for (const kind of ['css', 'portable', 'portable-subset'] as const) {
      expect(artifact(plan, kind).available).toBe(false);
      expect(artifact(plan, kind).blockedReason).toContain('accessibility');
      expect(artifact(plan, kind).files).toEqual([]);
    }
    expect(artifact(plan, 'source').available).toBe(true);
    expect(artifact(plan, 'report').available).toBe(true);
  });

  test('a base this build does not ship exports its source only', async () => {
    const other = {
      ...snapshot.envelope,
      base: { ...snapshot.envelope.base, sourceDigest: 'sha256:another-corpus' },
    };
    const snap = await takeExportSnapshot(createDraft(other), evaluator);
    const plan = planExports(snap, true);
    expect(snap.baseIsCurrent).toBe(false);
    expect(artifact(plan, 'source').caveat).toBe('Unvalidated');
    expect(artifact(plan, 'css').blockedReason).toContain('different Cinder base');
    expect(artifact(plan, 'report').files[0]!.text).toContain('"matchesThisBuild": false');
  });

  test('the same digest under the pre-stamp `workspace` label is still this build (COR-231)', async () => {
    const relabelled = {
      ...snapshot.envelope,
      base: { ...snapshot.envelope.base, packageVersion: 'workspace' },
    };
    const snap = await takeExportSnapshot(createDraft(relabelled), evaluator);
    expect(snap.baseIsCurrent).toBe(true);
    expect(artifact(planExports(snap, true), 'report').files[0]!.text).toContain(
      '"matchesThisBuild": true',
    );
  });
});

describe('deployment CSS', () => {
  const css = artifact(released, 'css');
  test('is a complete theme in the cinder-theme layer, with the edits and CSS-only edit', () => {
    expect(css.available).toBe(true);
    const text = css.files[0]!.text;
    expect(css.files[0]!.filename).toBe('edited-theme-theme-aa.cinder-theme.css');
    expect(text).toContain('@layer cinder-theme {');
    expect(text).toContain('--cinder-radius-md: 5px;');
    expect(text).toContain('--cinder-carousel-slide-size: 80%;');
    expect(text).toContain(`Cinder ${CINDER_BASE.packageVersion} ${CINDER_BASE.sourceDigest}`);
    expect(text).toContain('environment');
  });
});

describe('portable DTCG documents', () => {
  const complete = artifact(released, 'portable');
  const subset = artifact(released, 'portable-subset');

  test('complete export is blocked because CSS-only tokens have no faithful DTCG form', () => {
    expect(complete.available).toBe(false);
    expect(complete.blockedReason).toContain('4 tokens have no faithful DTCG representation');
    expect(complete.files).toEqual([]);
  });

  test('the explicit subset lists the four CSS-only tokens and writes no placeholder', () => {
    expect(released.portable.omitted.map((o) => o.path)).toEqual([
      'carousel.aspect-ratio',
      'carousel.slide-size',
      'code-block.height',
      'spinner.indicator',
    ]);
    const files = subset.files;
    expect(files.length).toBe(7);
    expect(files.at(-1)?.filename).toEndWith('.portability-report.json');
    for (const file of files.slice(0, 6)) {
      expect(file.text).not.toContain('"slide-size"');
      expect(file.text).not.toContain('"cssRecipe"');
      expect(file.text).not.toContain('com.lostgradient.cinder"');
    }
  });

  test('has one document per context, named theme-mode-motion, keeping aliases and extensions', () => {
    const names = released.portable.documents.map((d) => d.filename);
    expect(names).toEqual([
      'edited-theme-light-default.tokens.json',
      'edited-theme-light-reduced.tokens.json',
      'edited-theme-light-forced-reduced-motion.tokens.json',
      'edited-theme-dark-default.tokens.json',
      'edited-theme-dark-reduced.tokens.json',
      'edited-theme-dark-forced-reduced-motion.tokens.json',
    ]);
    const dark = released.portable.documents[3]!.document as any;
    expect(dark.radius.large.$value).toEqual({ value: 14, unit: 'px' });
    expect(dark.radius.small.$value).toBe('{radius.medium}');
    expect(dark.radius.small.$description).toBe('Follows medium.');
    const light = released.portable.documents[0]!.document as any;
    expect(light.radius.large.$value).not.toEqual({ value: 14, unit: 'px' });
    expect(light.specimen.accent.$extensions).toEqual({ 'com.example.vendor': { keep: true } });
  });

  test('includes an unbound Source token in every context and reports what it dropped', () => {
    expect(released.portable.sourceTokensIncluded).toBe(1);
    for (const doc of released.portable.documents) {
      expect((doc.document as any).specimen.accent.$type).toBe('color');
    }
    expect(released.portable.recipesNotExported.length).toBeGreaterThan(0);
    expect(released.portable.metadataStripped).toBeGreaterThan(300);
  });

  test('the portability report says what was omitted and that nothing replaced it', () => {
    const report = JSON.parse(subset.files.at(-1)!.text);
    expect(report.complete).toBe(false);
    expect(report.omittedTokens.length).toBe(4);
    expect(report.summary).toContain('No placeholder');
    expect(report.cinderBase.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });

  test('the subset re-imports as a supported DTCG document without CSS bindings', async () => {
    const dark = released.portable.documents[3]!;
    const result = await preflightImport(dark.text, dark.filename, pristine.envelope);
    expect(result.outcome).toBe('dtcg-document');
  });
});

describe('the validation report', () => {
  const report = JSON.parse(artifact(released, 'report').files[0]!.text);

  test('names the exact Cinder base, the revision and the findings summary', () => {
    expect(report.cinderBase).toEqual({
      packageVersion: CINDER_BASE.packageVersion,
      sourceDigest: CINDER_BASE.sourceDigest,
      matchesThisBuild: true,
    });
    expect(report.checked.revision).toBe(draft.revision);
    expect(report.checked.contexts).toHaveLength(6);
    expect(Object.keys(report.findings.summary)).toContain('accessibility-error');
  });

  test('lists the remaining limitations and is not a certification', () => {
    const text = report.limitations.join(' ');
    expect(text).toContain('not an accessibility certification');
    expect(text).toContain('environment');
    expect(text).toContain('not a standard DTCG document');
  });

  test('is deterministic for a revision', () => {
    const again = planExports(snapshot, true);
    expect(artifact(again, 'report').files[0]!.text).toBe(
      artifact(released, 'report').files[0]!.text,
    );
  });
});

describe('delivery', () => {
  const file = { filename: 'a.json', mime: 'application/json', text: '{}' };

  test('copies when the clipboard works and downloads nothing', async () => {
    const copied: string[] = [];
    const downloads: string[] = [];
    const result = await copyOrDownload(file, {
      writeText: async (text) => void copied.push(text),
      download: (f) => void downloads.push(f.filename),
    });
    expect(result.method).toBe('copied');
    expect(copied).toEqual(['{}']);
    expect(downloads).toEqual([]);
  });

  test.each([
    ['denied', async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))],
    [
      'throws synchronously',
      () => {
        throw new Error('no clipboard');
      },
    ],
    ['absent', undefined],
  ])('falls back to a download when the clipboard is %s', async (_label, writeText) => {
    const downloads: string[] = [];
    const result = await copyOrDownload(file, {
      writeText: writeText as undefined,
      download: (f) => void downloads.push(f.text),
    });
    expect(result.method).toBe('downloaded');
    expect(result.message).toContain('downloaded instead');
    expect(downloads).toEqual(['{}']);
  });

  test('download hands the file over untouched', () => {
    const seen: string[] = [];
    expect(downloadFile(file, { download: (f) => void seen.push(f.filename) }).method).toBe(
      'downloaded',
    );
    expect(seen).toEqual(['a.json']);
  });
});
