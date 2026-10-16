/**
 * Import preflight, transactional apply and the unsafe-input rejections (COR-486). The heavy
 * work (evaluating a real theme in six contexts) happens at module scope, untimed; the tests
 * assert on what it captured.
 */

import { CINDER_BASE, computeSourceDigest } from '@lostgradient/cinder/tokens/runtime';
import { describe, expect, test } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import { THEME_DATA_LIMITS } from './theme-draft-limits.ts';
import { editableState, type ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { applyImport } from './theme-import-apply.ts';
import { preflightImport } from './theme-import-preflight.ts';
import { canApply, type PreflightResult } from './theme-import-types.ts';
import { editedEnvelope, envelopeText, openController } from './theme-interchange-test-support.ts';

const current = createEnvelope('open-theme', 'Open theme', cinderThemeBase());
const edited = editedEnvelope();
const editedText = envelopeText(edited);

const run = (text: string): Promise<PreflightResult> => preflightImport(text, 'in.json', current);
const codes = (result: PreflightResult): string[] => result.findings.map((f) => f.code);

const envelopeWith = (patch: (copy: Record<string, any>) => void): string => {
  const copy = JSON.parse(editedText) as Record<string, any>;
  patch(copy);
  return JSON.stringify(copy);
};

const supportedEnvelope = await run(editedText);
const supportedDocument = await run(
  JSON.stringify({
    $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
    radius: { medium: { $type: 'dimension', $value: { value: 7, unit: 'px' } } },
    extra: { brand: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0] } } },
  }),
);
const resolverOnly = await run(
  JSON.stringify({
    version: '2025.10',
    sets: { a: { sources: [{ tokens: {} }] } },
    modifiers: {
      theme: { contexts: { light: [] }, default: 'light' },
      product: { contexts: { x: [] } },
    },
    resolutionOrder: [{ $ref: '#/sets/a' }],
  }),
);
const json5 = await run("{ 'a': 1, // note\n b: 2, }");
const acronis = await run(
  JSON.stringify({ color: { brand: { values: { light: '#fff' }, platforms: ['web'] } } }),
);
const spectrum = await run(
  JSON.stringify({
    'gray-100': { sets: { light: { value: 'rgb(1,1,1)' }, dark: { value: 'rgb(2,2,2)' } } },
  }),
);
const notJson = await run('not json at all');
const unknownShape = await run(JSON.stringify({ hello: 'world' }));
// A different corpus, honestly digested: the version alone no longer makes a base incompatible.
const otherResolver = { ...CINDER_BASE.resolver, description: 'Another Cinder corpus' };
const otherDigest = await computeSourceDigest({
  resolver: otherResolver,
  documents: CINDER_BASE.documents,
});
const incompatible = await run(
  envelopeWith((copy) => {
    copy['base'] = {
      ...copy['base'],
      packageVersion: '0.0.0-other',
      resolver: otherResolver,
      sourceDigest: otherDigest,
    };
  }),
);
// Exported before the Playground stamped Cinder's published version (COR-231).
const workspaceLabelled = await run(
  envelopeWith((copy) => {
    copy['base'] = { ...copy['base'], packageVersion: 'workspace' };
  }),
);

describe('the four preflight outcomes', () => {
  test('a supported Cinder envelope shows its axes and facts and is applicable', () => {
    expect(supportedEnvelope.outcome).toBe('cinder-envelope');
    expect(canApply(supportedEnvelope)).toBe(true);
    expect(supportedEnvelope.axes.join(' ')).toContain('theme: light, dark');
    expect(supportedEnvelope.facts.find((f) => f.label === 'CSS-only edits')?.value).toBe('1');
    expect(supportedEnvelope.base?.compatible).toBe(true);
  });

  test('a supported DTCG document lists known targets and Source tokens', () => {
    expect(supportedDocument.outcome).toBe('dtcg-document');
    expect(canApply(supportedDocument)).toBe(true);
    const facts = Object.fromEntries(supportedDocument.facts.map((f) => [f.label, f.value]));
    expect(facts['Known Cinder tokens']).toBe('1');
    expect(facts['Source tokens (kept, no CSS)']).toBe('1');
  });

  test.each([
    ['a resolver with an extra product axis', resolverOnly, 'product'],
    ['JSON5-like syntax', json5, 'JSON5'],
    ['Acronis values and platforms', acronis, 'platforms'],
    ['Spectrum cascade records', spectrum, 'light'],
  ])('%s is an unsupported profile, never invalid DTCG', (_label, result, needle) => {
    expect(result.outcome).toBe('unsupported-profile');
    expect(canApply(result)).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.detail.toLowerCase()).not.toContain('invalid dtcg');
    expect(JSON.stringify([result.axes, result.unsupported])).toContain(needle);
  });

  test('broken JSON and unknown shapes are invalid input with a recovery path', () => {
    expect(notJson.outcome).toBe('invalid');
    expect(codes(notJson)).toEqual(['invalid-json']);
    expect(unknownShape.outcome).toBe('invalid');
    expect(codes(unknownShape)).toEqual(['unrecognized']);
    for (const result of [notJson, unknownShape]) {
      expect(canApply(result)).toBe(false);
      expect('text' in result.source).toBe(true);
    }
  });

  test('every rejected input keeps its text so it can be downloaded unchanged', () => {
    for (const result of [resolverOnly, json5, acronis, spectrum, notJson, incompatible]) {
      expect('text' in result.source && result.source.text.length > 0).toBe(true);
    }
  });
});

describe('incompatible base', () => {
  test('is a read-only state with the compared versions, never silently rebased', () => {
    expect(incompatible.outcome).toBe('cinder-envelope');
    expect(incompatible.base?.sourceDigest).toBe(otherDigest);
    expect(incompatible.base?.compatible).toBe(false);
    expect(incompatible.base?.packageVersion).toBe('0.0.0-other');
    expect(incompatible.base?.currentPackageVersion).toBe(CINDER_BASE.packageVersion);
    expect(canApply(incompatible)).toBe(false);
    expect(incompatible.candidate).toBeNull();
  });

  test('the same digest under another version label is the same base, and Apply restamps it', () => {
    expect(workspaceLabelled.outcome).toBe('cinder-envelope');
    expect(workspaceLabelled.base?.compatible).toBe(true);
    expect(workspaceLabelled.base?.packageVersion).toBe('workspace');
    expect(canApply(workspaceLabelled)).toBe(true);
    const candidate = workspaceLabelled.candidate;
    expect(candidate?.kind).toBe('envelope');
    if (candidate?.kind !== 'envelope') throw new Error('expected an envelope candidate');
    expect(candidate.envelope.base.packageVersion).toBe(CINDER_BASE.packageVersion);
    expect(candidate.envelope.base.sourceDigest).toBe(CINDER_BASE.sourceDigest);
  });

  test('a digest that does not match the embedded base is refused as untrusted', async () => {
    const result = await run(
      envelopeWith((copy) => {
        copy['base'].sourceDigest = 'sha256:00';
      }),
    );
    expect(result.outcome).toBe('invalid');
    expect(codes(result)).toEqual(['bad-base-digest']);
  });
});

describe('unsafe input is refused before classification', () => {
  const bad = async (text: string) => {
    const result = await run(text);
    expect(result.outcome).toBe('invalid');
    expect(result.candidate).toBeNull();
    return codes(result);
  };

  test.each(['__proto__', 'constructor', 'prototype'])('the key %s anywhere', async (key) => {
    expect(await bad(`{"radius":{"medium":{"$value":1,"${key}":{"x":1}}}}`)).toContain(
      'prototype-key',
    );
    expect(
      await bad(envelopeWith((copy) => (copy['overrides'].shared = JSON.parse(`{"${key}":{}}`)))),
    ).toContain('prototype-key');
  });

  test.each([
    '../escape.tokens.json',
    '/etc/passwd',
    'sets/../../x.json',
    'https://example.test/x.json',
    'C:/x.json',
    'sets/%2e%2e/x.json',
    'sets\\x.json',
  ])('path traversal in the bundle: %s', async (path) => {
    const text = envelopeWith((copy) => {
      copy['base'].documents[path] = {};
    });
    expect(await bad(text)).toContain('path-traversal');
  });

  test('duplicate normalized paths', async () => {
    const text = envelopeWith((copy) => {
      copy['base'].documents['./sets//colors.tokens.json'] = {};
    });
    expect(await bad(text)).toContain('duplicate-path');
  });

  test('a resolver reference that leaves the bundle', async () => {
    const text = envelopeWith((copy) => {
      copy['base'].resolver.sets.foundation.sources.push({ $ref: '../outside.json' });
    });
    expect(await bad(text)).toContain('path-traversal');
  });

  test('a CSS binding outside the public registry, on a Source token and on a public one', async () => {
    const binding = (property: string) => ({
      $type: 'color',
      $value: { colorSpace: 'srgb', components: [0, 0, 0] },
      $extensions: { 'com.lostgradient.cinder': { cssProperty: property } },
    });
    expect(await bad(JSON.stringify({ brand: { main: binding('--cinder-x') } }))).toContain(
      'foreign-css-binding',
    );
    expect(await bad(JSON.stringify({ radius: { medium: binding('--evil') } }))).toContain(
      'foreign-css-binding',
    );
    expect(
      await bad(
        envelopeWith((copy) => (copy['cssOverrides']['not.a.token'] = { 'dark/default': '1px' })),
      ),
    ).toContain('foreign-css-binding');
  });

  test.each([
    'url(https://example.test/x.png)',
    'red; background: url(x)',
    '1px /* c */',
    '@import "x"',
    'image-set(x)',
  ])('resource-bearing CSS: %s', async (value) => {
    const text = envelopeWith((copy) => {
      copy['cssOverrides']['carousel.slide-size'] = { 'dark/default': value };
    });
    expect(await bad(text)).toContain('resource-bearing-css');
    const recipe = JSON.stringify({
      brand: {
        $type: 'number',
        $value: 1,
        $extensions: { 'com.lostgradient.cinder': { cssRecipe: value } },
      },
    });
    expect(await bad(recipe)).toContain('resource-bearing-css');
  });

  test('an unresolved reference', async () => {
    const text = JSON.stringify({
      radius: { medium: { $type: 'dimension', $value: '{radius.nowhere}' } },
    });
    expect(await bad(text)).toContain('unresolved-reference');
  });

  test('a public target whose type changes', async () => {
    const text = JSON.stringify({
      radius: { medium: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0] } } },
    });
    expect(await bad(text)).toContain('public-type-change');
  });

  test('a DTCG value for a CSS-only token', async () => {
    const text = JSON.stringify({ carousel: { 'slide-size': { $type: 'number', $value: 3 } } });
    expect(await bad(text)).toContain('css-only-target');
  });

  test('the limits run first: oversize file, too many documents, long paths, deep nesting', async () => {
    expect(await bad(' '.repeat(THEME_DATA_LIMITS.fileBytes + 1))).toEqual(['file-too-large']);
    const many = envelopeWith((copy) => {
      for (let i = 0; i < THEME_DATA_LIMITS.documents + 1; i += 1)
        copy['base'].documents[`d${i}.json`] = {};
    });
    expect(await bad(many)).toContain('too-many-documents');
    const longSegment = JSON.stringify({ ['a'.repeat(81)]: { $type: 'number', $value: 1 } });
    expect(await bad(longSegment)).toContain('segment-too-long');
    let deep: unknown = { $type: 'number', $value: 1 };
    for (let i = 0; i < 40; i += 1) deep = { g: deep };
    expect(await bad(JSON.stringify(deep))).toContain('nesting-too-deep');
    const nested = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect(await bad(nested)).not.toBeUndefined();
  });

  test('invalid DTCG reports the original path (em dimension, missing type, bad strokeStyle)', async () => {
    const em = await run(
      JSON.stringify({ type: { size: { $type: 'dimension', $value: { value: 1, unit: 'em' } } } }),
    );
    expect(em.outcome).toBe('invalid');
    expect(em.findings.some((f) => f.path.includes('type.size'))).toBe(true);
    const untyped = await run(JSON.stringify({ lone: { $value: 3 } }));
    expect(untyped.outcome).toBe('invalid');
    const stroke = await run(JSON.stringify({ line: { $type: 'strokeStyle', $value: 'none' } }));
    expect(stroke.outcome).toBe('invalid');
    expect(stroke.findings.some((f) => f.path.includes('line'))).toBe(true);
  });
});

describe('applying an import is transactional', () => {
  test('a failed import leaves the draft, revision, history and preview values unchanged', async () => {
    const controller = await openController();
    const before = {
      draft: controller.draft,
      revision: controller.draft?.revision,
      history: controller.history,
      values: controller.draftValues,
    };
    const bad = await preflightImport(
      JSON.stringify({ radius: { medium: { $type: 'dimension', $value: '{radius.nowhere}' } } }),
      'bad.json',
      controller.draft!.envelope,
    );
    const outcome = await applyImport(controller, bad, 'replace');
    expect(outcome.ok).toBe(false);
    expect(controller.draft).toBe(before.draft);
    expect(controller.draft?.revision).toBe(before.revision);
    expect(controller.history).toBe(before.history);
    expect(controller.draftValues).toBe(before.values);
  });

  test('a rejection after preflight (invalid at commit time) also changes nothing', async () => {
    const controller = await openController();
    const good = await preflightImport(envelopeText(edited), 'e.json', controller.draft!.envelope);
    const forged: PreflightResult = {
      ...good,
      candidate: {
        kind: 'envelope',
        envelope: {
          ...edited,
          overrides: {
            ...edited.overrides,
            shared: { radius: { medium: { $type: 'dimension', $value: '{radius.nowhere}' } } },
          },
        },
      },
      source: { file: new File(['{}'], 'x.json') },
    };
    const before = controller.draft;
    const outcome = await applyImport(controller, forged, 'replace');
    expect(outcome.ok).toBe(false);
    expect(controller.draft).toBe(before);
  });

  test('a successful import is one undoable transaction, and undo restores the draft', async () => {
    const controller = await openController();
    const before = editableState(controller.draft!.envelope);
    const result = await preflightImport(editedText, 'e.json', controller.draft!.envelope);
    const outcome = await applyImport(controller, result, 'replace');
    expect(outcome.ok).toBe(true);
    expect(controller.draft?.envelope.overrides).toEqual(edited.overrides);
    expect(controller.draft?.envelope.cssOverrides).toEqual(edited.cssOverrides);
    expect(controller.draft?.envelope.id).not.toBe(edited.id);
    expect(controller.history?.entries.length).toBe(1);
    expect(controller.history?.entries[0]?.kind).toBe('import');
    await controller.undo();
    expect(editableState(controller.draft!.envelope)).toEqual(before);
    await controller.redo();
    expect(controller.draft?.envelope.overrides).toEqual(edited.overrides);
  });

  test('import as a copy adds a theme with a unique suffix and leaves the original', async () => {
    const controller = await openController();
    const originalId = controller.library.activeId!;
    const original = controller.draft;
    const text = envelopeWith((copy) => (copy['name'] = 'Cinder default'));
    const result = await preflightImport(text, 'e.json', controller.draft!.envelope);
    const outcome = await applyImport(controller, result, 'copy');
    expect(outcome.ok).toBe(true);
    expect(controller.library.entries[originalId]?.draft).toBe(original!);
    expect(controller.draft?.envelope.name).toBe('Cinder default 2');
    expect(controller.library.activeId).not.toBe(originalId);
  });

  test('a DTCG overlay merges into shared overrides and undo removes it', async () => {
    const controller = await openController();
    const result = await preflightImport(
      JSON.stringify({
        radius: { medium: { $type: 'dimension', $value: { value: 7, unit: 'px' } } },
        brand: { main: { $type: 'number', $value: 3 } },
      }),
      'd.json',
      controller.draft!.envelope,
    );
    const applied = await applyImport(controller, result, 'replace');
    expect(applied.ok).toBe(true);
    const shared = controller.draft!.envelope.overrides.shared;
    expect(Object.keys(shared).toSorted()).toEqual(['brand', 'radius']);
    expect(controller.draftValues.get('--cinder-radius-md')).toBe('7px');
    await controller.undo();
    expect(controller.draft!.envelope.overrides.shared).toEqual({});
  });
});

describe('the unchanged envelope, applied, evaluates like the original', () => {
  test('values match for the active context', async () => {
    const controller = await openController();
    const result = await preflightImport(editedText, 'e.json', controller.draft!.envelope);
    await applyImport(controller, result, 'replace');
    expect(controller.draftValues.get('--cinder-radius-md')).toBe('5px');
    expect(controller.draftValues.get('--cinder-radius-sm')).toBe('var(--cinder-radius-md)');
  });
});

export type { ThemeEnvelope };
