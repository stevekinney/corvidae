/**
 * The content-keyed evaluator the editor suites share (COR-1572). What it remembers must be
 * everything an evaluation reads, or a test replays another test's result.
 */

import { describe, expect, test } from 'bun:test';

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';

import { cinderThemeBase } from './theme-builder-base.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import type { ThemeBase, ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { createMemoEvaluator } from './theme-reference-test-support.ts';

/** A stand-in for the runtime that counts its calls and answers with a fresh result each time. */
function countingEvaluator() {
  const calls: number[] = [];
  const evaluator: ThemeEvaluator = {
    async evaluate(_source, revision, context): Promise<ThemeEvaluation> {
      calls.push(revision);
      return {
        revision,
        context,
        ok: true,
        properties: [{ name: '--a', value: String(calls.length) }],
      };
    },
  };
  return { calls, evaluator };
}

const envelopeOver = (base: ThemeBase): ThemeEnvelope => createEnvelope('memo', 'Memo', base);

describe('the memoizing evaluator', () => {
  test('equal states share one evaluation, stamped with each caller’s revision', async () => {
    const { calls, evaluator } = countingEvaluator();
    const memo = createMemoEvaluator(evaluator);
    const first = await memo.evaluate(envelopeOver(cinderThemeBase()), 1, 'light/default');
    const second = await memo.evaluate(envelopeOver(cinderThemeBase()), 2, 'light/default');
    expect(calls).toEqual([1]);
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(second.ok && second.properties).toEqual(first.ok ? first.properties : []);
  });

  test('equal overrides over different base digests do not share a cached result', async () => {
    const { calls, evaluator } = countingEvaluator();
    const memo = createMemoEvaluator(evaluator);
    const shipped = envelopeOver(cinderThemeBase());
    const relabelled = envelopeOver({ ...cinderThemeBase(), sourceDigest: 'another-digest' });
    expect(relabelled.overrides).toEqual(shipped.overrides);
    await memo.evaluate(shipped, 1, 'light/default');
    await memo.evaluate(relabelled, 2, 'light/default');
    expect(calls).toEqual([1, 2]);
    await memo.evaluate(relabelled, 3, 'light/default');
    expect(calls).toEqual([1, 2]);
  });

  test('a base that is not the shipped corpus is never remembered', async () => {
    const { calls, evaluator } = countingEvaluator();
    const memo = createMemoEvaluator(evaluator);
    const foreign = envelopeOver({
      ...cinderThemeBase(),
      documents: { ...CINDER_BASE.documents } as ThemeBase['documents'],
    });
    await memo.evaluate(foreign, 1, 'light/default');
    await memo.evaluate(foreign, 2, 'light/default');
    expect(calls).toEqual([1, 2]);
  });

  test('a replayed result is frozen, so a test cannot change what a later test sees', async () => {
    const { evaluator } = countingEvaluator();
    const memo = createMemoEvaluator(evaluator);
    const result = await memo.evaluate(envelopeOver(cinderThemeBase()), 1, 'light/default');
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok && Object.isFrozen(result.properties)).toBe(true);
  });
});
