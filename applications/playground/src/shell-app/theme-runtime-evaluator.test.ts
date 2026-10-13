import { describe, expect, it } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import { EvaluationGate } from './theme-draft-evaluation.ts';
import type { ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';
import { applyEdit, createDraft, type DraftEdit } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import { buildThemeSources, createRuntimeEvaluator } from './theme-runtime-evaluator.ts';

const px = (value: number) => ({ $type: 'dimension', $value: { value, unit: 'px' } });
const ms = (value: number) => ({ $type: 'duration', $value: { value, unit: 'ms' } });

function envelopeWith(...edits: DraftEdit[]): ThemeEnvelope {
  let draft = createDraft(createEnvelope('theme-1', 'Test theme', cinderThemeBase()));
  for (const edit of edits) {
    const result = applyEdit(draft, edit);
    if (!result.ok) throw new Error('edit rejected');
    draft = result.draft;
  }
  return draft.envelope;
}

async function property(
  envelope: ThemeEnvelope,
  context: ThemeContextId,
  name: string,
  revision = 1,
): Promise<string | undefined> {
  const result = await createRuntimeEvaluator().evaluate(envelope, revision, context);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join('; '));
  return result.properties.find((entry) => entry.name === name)?.value;
}

describe('buildThemeSources', () => {
  it('inserts each override document after the layer it overrides', () => {
    const sources = buildThemeSources(envelopeWith(), 4);
    const resolver = sources.resolver as {
      sets: { foundation: { sources: Array<{ $ref: string }> } };
      modifiers: Record<string, { contexts: Record<string, Array<{ $ref: string }>> }>;
    };
    const refs = (list: Array<{ $ref: string }>) => list.map((entry) => entry.$ref);
    expect(refs(resolver.sets.foundation.sources).at(-1)).toBe('overrides/shared.tokens.json');
    expect(refs(resolver.modifiers['theme']!.contexts['light']!)).toEqual([
      'themes/light.tokens.json',
      'overrides/light.tokens.json',
    ]);
    expect(refs(resolver.modifiers['theme']!.contexts['dark']!)).toEqual([
      'themes/dark.tokens.json',
      'overrides/dark.tokens.json',
    ]);
    expect(refs(resolver.modifiers['motion']!.contexts['default']!)).toEqual([
      'modes/motion-default.tokens.json',
    ]);
    expect(refs(resolver.modifiers['motion']!.contexts['reduced']!)).toEqual([
      'modes/motion-reduced.tokens.json',
      'overrides/reduced.tokens.json',
    ]);
    expect(refs(resolver.modifiers['motion']!.contexts['forced-reduced-motion']!)).toEqual([
      'modes/motion-forced-reduced.tokens.json',
      'overrides/forced-reduced-motion.tokens.json',
    ]);
    expect(sources.revision).toBe(4);
  });

  it('never edits the embedded base', () => {
    const envelope = envelopeWith();
    const before = JSON.stringify(envelope.base.resolver);
    buildThemeSources(envelope, 1);
    expect(JSON.stringify(envelope.base.resolver)).toBe(before);
  });
});

describe('the runtime evaluator', () => {
  it('projects the shipped base when nothing is overridden', async () => {
    const value = await property(envelopeWith(), 'light/default', '--cinder-radius-md');
    expect(value).toBe('0.5rem');
  });

  it('applies a shared override in every context', async () => {
    const envelope = envelopeWith({
      kind: 'set-override',
      scope: 'shared',
      path: 'radius.medium',
      node: px(3),
    });
    for (const context of [
      'light/default',
      'dark/reduced',
      'light/forced-reduced-motion',
    ] as const) {
      expect(await property(envelope, context, '--cinder-radius-md')).toBe('3px');
    }
  });

  it('lets a color-mode override win over a shared one, in that mode only', async () => {
    const envelope = envelopeWith(
      { kind: 'set-override', scope: 'shared', path: 'radius.medium', node: px(3) },
      { kind: 'set-override', scope: 'dark', path: 'radius.medium', node: px(5) },
    );
    expect(await property(envelope, 'light/default', '--cinder-radius-md')).toBe('3px');
    expect(await property(envelope, 'dark/default', '--cinder-radius-md')).toBe('5px');
    expect(await property(envelope, 'dark/reduced', '--cinder-radius-md')).toBe('5px');
  });

  it('lets a motion override win over the motion base, in that mode only', async () => {
    const envelope = envelopeWith({
      kind: 'set-override',
      scope: 'reduced',
      path: 'motion.fast',
      node: ms(40),
    });
    expect(await property(envelope, 'light/reduced', '--cinder-duration-fast')).toBe('40ms');
    expect(await property(envelope, 'dark/reduced', '--cinder-duration-fast')).toBe('40ms');
    expect(await property(envelope, 'light/default', '--cinder-duration-fast')).not.toBe('40ms');
    expect(
      await property(envelope, 'light/forced-reduced-motion', '--cinder-duration-fast'),
    ).not.toBe('40ms');
  });

  it('applies CSS-only overrides last, to their own context only', async () => {
    const envelope = envelopeWith(
      { kind: 'set-override', scope: 'shared', path: 'radius.medium', node: px(3) },
      { kind: 'set-css-override', path: 'radius.medium', context: 'dark/default', value: '1.5rem' },
    );
    expect(await property(envelope, 'dark/default', '--cinder-radius-md')).toBe('1.5rem');
    expect(await property(envelope, 'dark/reduced', '--cinder-radius-md')).toBe('3px');
    expect(await property(envelope, 'light/default', '--cinder-radius-md')).toBe('3px');
  });

  it('ignores a CSS-only value the preview frame would reject', async () => {
    const envelope = envelopeWith({
      kind: 'set-css-override',
      path: 'radius.medium',
      context: 'light/default',
      value: 'url(https://example.test/x)',
    });
    expect(await property(envelope, 'light/default', '--cinder-radius-md')).toBe('0.5rem');
  });

  it('reports a path-addressed diagnostic for a value the runtime rejects', async () => {
    const envelope = envelopeWith({
      kind: 'set-override',
      scope: 'shared',
      path: 'radius.medium',
      node: { $type: 'dimension', $value: { value: 3, unit: 'furlong' } },
    });
    const result = await createRuntimeEvaluator().evaluate(envelope, 2, 'light/default');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.revision).toBe(2);
    expect(result.diagnostics[0]?.code).toBe('invalid-theme');
    expect(result.diagnostics[0]?.path).toContain('radius');
  });

  it('returns a remembered result for the same envelope, revision and context', async () => {
    const evaluator = createRuntimeEvaluator();
    const envelope = envelopeWith();
    const first = await evaluator.evaluate(envelope, 1, 'light/default');
    expect(await evaluator.evaluate(envelope, 1, 'light/default')).toBe(first);
    expect(await evaluator.evaluate(envelope, 1, 'dark/default')).not.toBe(first);
  });

  it('is gated: a response for a superseded revision is dropped', async () => {
    const evaluator = createRuntimeEvaluator();
    const gate = new EvaluationGate();
    const first = envelopeWith();
    const second = envelopeWith({
      kind: 'set-override',
      scope: 'shared',
      path: 'radius.medium',
      node: px(2),
    });
    const stale = gate.request(evaluator, 't', first, 1, 'light/default');
    const current = gate.request(evaluator, 't', second, 2, 'light/default');
    expect(await stale).toBeNull();
    const accepted = await current;
    expect(accepted?.ok).toBe(true);
    expect(accepted?.revision).toBe(2);
  });
});
