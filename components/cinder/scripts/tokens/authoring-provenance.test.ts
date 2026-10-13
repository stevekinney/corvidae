import { describe, expect, test } from 'bun:test';

import { authoringContexts, authoringLayerStack } from './authoring-catalogue.ts';
import { traceProvenance } from './authoring-provenance.ts';
import { cloneCorpus, loadProfileCorpus } from './authoring-test-support.ts';
import { collectEntries, type CorpusEntry } from './corpus.ts';
import { loadCorpus } from './generate.ts';
import { mergeAndExpandExtends, resolveDocuments } from './resolve.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';

const BASE = 'profile-base.tokens.json';
const LIGHT = 'profile-light.tokens.json';
const DARK = 'profile-dark.tokens.json';
const REDUCED = 'profile-motion-reduced.tokens.json';
const FORCED = 'profile-motion-forced.tokens.json';

type Corpus = { resolver: ResolverDocument; documentsByPath: Map<string, TokenDocument> };

function traceContext(corpus: Corpus, theme: string, motion: string) {
  const context = authoringContexts(corpus.resolver).find(
    (c) => c.theme === theme && c.motion === motion,
  )!;
  const stack = authoringLayerStack(corpus.resolver, corpus.documentsByPath, context);
  return { stack, trace: traceProvenance(stack) };
}

describe('traceProvenance on the profile fixture', () => {
  const corpus = loadProfileCorpus();

  test('a theme override wins over the shared set and the contributing layers are ordered', () => {
    const { trace } = traceContext(corpus, 'light', 'default');
    const paper = trace.get('palette.paper')!;
    expect(paper.winner).toEqual({ document: LIGHT, path: 'palette.paper' });
    expect(paper.layers.map((layer) => [layer.document, layer.via])).toEqual([
      [BASE, 'declared'],
      [LIGHT, 'declared'],
    ]);
    expect(trace.get('palette.paper')!.layers.map((l) => l.layer)).toEqual([
      'sets.foundation',
      'theme.light',
    ]);
  });

  test('an inherited type is attributed to the group that declares it, in the last layer that does', () => {
    const light = traceContext(corpus, 'light', 'default').trace.get('palette.paper')!;
    expect(light.effectiveType).toEqual({
      type: 'color',
      origin: 'inherited',
      declaredAt: { document: BASE, path: 'palette' },
    });
    // The dark theme restates the group type, so the declaring layer moves with it.
    const dark = traceContext(corpus, 'dark', 'default').trace.get('palette.paper')!;
    expect(dark.effectiveType.declaredAt).toEqual({ document: DARK, path: 'palette' });
    expect(dark.effectiveType.origin).toBe('inherited');
  });

  test('a locally typed token reports a local type at its own path', () => {
    const halo = traceContext(corpus, 'light', 'default').trace.get('palette.halo')!;
    expect(halo.effectiveType).toEqual({
      type: 'color',
      origin: 'local',
      declaredAt: { document: BASE, path: 'palette.halo' },
    });
  });

  test('a later modifier overrides an earlier one: motion beats theme', () => {
    const dark = traceContext(corpus, 'dark', 'default').trace.get('palette.halo')!;
    expect(dark.winner.document).toBe(DARK);
    const forcedDark = traceContext(corpus, 'dark', 'forced-reduced-motion').trace.get(
      'palette.halo',
    )!;
    expect(forcedDark.winner.document).toBe(FORCED);
    expect(forcedDark.layers.map((l) => l.document)).toEqual([BASE, DARK, FORCED]);
    const forcedLight = traceContext(corpus, 'light', 'forced-reduced-motion').trace.get(
      'palette.halo',
    )!;
    expect(forcedLight.winner.document).toBe(FORCED);
  });

  test('a motion context overrides the shared value and leaves the type inherited from the set', () => {
    const fast = (motion: string) =>
      traceContext(corpus, 'light', motion).trace.get('motion.fast')!;
    expect(fast('default').winner.document).toBe(BASE);
    expect(fast('reduced').winner.document).toBe(REDUCED);
    expect(fast('forced-reduced-motion').winner.document).toBe(FORCED);
    expect(fast('reduced').effectiveType).toEqual({
      type: 'duration',
      origin: 'inherited',
      declaredAt: { document: BASE, path: 'motion' },
    });
  });

  test('two-hop aliases report only their direct input, and the dark theme breaks the chain', () => {
    const light = traceContext(corpus, 'light', 'default').trace;
    expect(light.get('palette.accent-strong')!.inputs.aliases).toEqual(['palette.accent']);
    expect(light.get('palette.accent')!.inputs.aliases).toEqual(['palette.paper']);
    const dark = traceContext(corpus, 'dark', 'default').trace;
    expect(dark.get('palette.accent')!.winner.document).toBe(DARK);
    expect(dark.get('palette.accent')!.inputs.aliases).toEqual([]);
    expect(dark.get('palette.accent-strong')!.winner.document).toBe(BASE);
  });

  test('a trusted recipe names the tokens it reads, and an override does not inherit the recipe', () => {
    const base = traceContext(corpus, 'light', 'default').trace.get('palette.halo')!;
    expect(base.inputs.recipes).toEqual([{ cssProperty: '--cinder-palette-ink', path: 'unknown' }]);
    const mapped = traceProvenance(traceContext(corpus, 'light', 'default').stack, {
      cssPropertyToPath: { '--cinder-palette-ink': 'palette.ink' },
    }).get('palette.halo')!;
    expect(mapped.inputs.recipes).toEqual([
      { cssProperty: '--cinder-palette-ink', path: 'palette.ink' },
    ]);
    const dark = traceContext(corpus, 'dark', 'default').trace.get('palette.halo')!;
    expect(dark.inputs.recipes).toEqual([]);
  });

  test('a member that arrives through $extends is attributed to the extended declaration', () => {
    const compact = traceContext(corpus, 'light', 'default').trace.get('card-compact.background')!;
    expect(compact.layers).toEqual([
      {
        document: BASE,
        kind: 'set',
        layer: 'sets.foundation',
        path: 'card-compact.background',
        via: 'extends',
      },
    ]);
    expect(compact.winner).toEqual({ document: BASE, path: 'card.background' });
    expect(compact.inputs.extends).toEqual([{ group: 'card-compact', target: 'card' }]);
    expect(compact.effectiveType.type).toBe('color');
    const own = traceContext(corpus, 'light', 'default').trace.get('card-compact.padding')!;
    expect(own.layers[0]!.via).toBe('declared');
    expect(own.winner.path).toBe('card-compact.padding');
  });

  test('an imported token with no cssProperty is traced in the contexts that carry it', () => {
    const light = traceContext(corpus, 'light', 'default').trace.get('imported.brand')!;
    expect(light.winner).toEqual({ document: LIGHT, path: 'imported.brand' });
    expect(light.effectiveType.origin).toBe('local');
    expect(traceContext(corpus, 'dark', 'default').trace.has('imported.brand')).toBe(false);
  });

  test('resetting an override returns provenance to the remaining layer', () => {
    const reset = cloneCorpus(corpus);
    delete (reset.documentsByPath.get(LIGHT)!['palette'] as Record<string, unknown>)['paper'];
    const after = traceContext(reset, 'light', 'default').trace.get('palette.paper')!;
    expect(after.winner).toEqual({ document: BASE, path: 'palette.paper' });
    expect(after.layers.map((l) => l.document)).toEqual([BASE]);

    // Removing the dark literal restores the alias to the shared declaration.
    const dark = cloneCorpus(corpus);
    delete (dark.documentsByPath.get(DARK)!['palette'] as Record<string, unknown>)['accent'];
    const accent = traceContext(dark, 'dark', 'default').trace.get('palette.accent')!;
    expect(accent.winner.document).toBe(BASE);
    expect(accent.inputs.aliases).toEqual(['palette.paper']);

    // Removing a motion override restores the shared value for that context only.
    const motion = cloneCorpus(corpus);
    delete (motion.documentsByPath.get(REDUCED)!['motion'] as Record<string, unknown>)['fast'];
    expect(traceContext(motion, 'light', 'reduced').trace.get('motion.fast')!.winner.document).toBe(
      BASE,
    );
  });
});

/**
 * The tracer must agree with the evaluator for every token. Resolution is
 * delegated to `resolveDocuments`, so these checks compare provenance against
 * its output rather than against expectations written by hand.
 */
function expectAgreesWithEvaluation(corpus: Corpus, expectedTypeKnown: boolean) {
  let compared = 0;
  for (const context of authoringContexts(corpus.resolver)) {
    const stack = authoringLayerStack(corpus.resolver, corpus.documentsByPath, context);
    const documents = stack.map((layer) => layer.content);
    const resolved = resolveDocuments(documents);
    const trace = traceProvenance(stack);
    const finalEntries = new Map<string, CorpusEntry>();
    collectEntries(mergeAndExpandExtends(documents), '', undefined, finalEntries);

    expect([...trace.keys()].toSorted()).toEqual(Object.keys(resolved).toSorted());
    for (const [path, provenance] of trace) {
      if (expectedTypeKnown)
        expect(provenance.effectiveType.type).toBe(resolved[path]!.$type ?? 'unknown');
      expect(provenance.layers.length).toBeGreaterThan(0);
      // The winning declaration's raw value is the merged token's raw value.
      const winnerLayer = stack.find((layer) => layer.document === provenance.winner.document)!;
      const winnerEntries = new Map<string, CorpusEntry>();
      collectEntries(winnerLayer.content, '', undefined, winnerEntries);
      const declared = winnerEntries.get(provenance.winner.path);
      expect(declared).toBeDefined();
      expect(declared!.value).toEqual(finalEntries.get(path)!.value);
      // No later layer supplies the token after the winner.
      const last = provenance.layers.at(-1)!;
      const winnerIndex = stack.findIndex((layer) => layer.document === provenance.winner.document);
      const lastIndex = stack.findIndex((layer) => layer.document === last.document);
      expect(winnerIndex).toBeLessThanOrEqual(lastIndex);
      compared++;
    }
  }
  return compared;
}

describe('traceProvenance agrees with resolveDocuments', () => {
  test('for every token and context of the profile fixture', () => {
    expect(expectAgreesWithEvaluation(loadProfileCorpus(), true)).toBeGreaterThan(50);
  });

  test('for every token and all six contexts of the real corpus', async () => {
    const corpus = await loadCorpus();
    const compared = expectAgreesWithEvaluation(corpus, true);
    expect(authoringContexts(corpus.resolver)).toHaveLength(6);
    expect(compared).toBeGreaterThan(authoringContexts(corpus.resolver).length * 300);
  });
});
