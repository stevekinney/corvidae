/**
 * The remediation algorithm and its proposals (COR-487): determinism, the lightness and
 * chroma grids, tie-breaking against an independent brute-force oracle, gamut, the
 * every-affected-pairing regression, pinned Culori outputs, and the specific blocking
 * explanation. The apply/undo transaction lives in `theme-remediation-apply.test.ts`.
 */

import { describe, expect, test } from 'bun:test';

import { CONTRAST_PAIRINGS, type ContrastPairing } from '@lostgradient/cinder/tokens/runtime';

import { inOutputGamut, targetChannels, type OutputGamut } from './theme-chroma-grid.ts';
import { createDraft } from './theme-draft.ts';
import { proposeForFinding } from './theme-remediation-apply.ts';
import {
  dimmedText,
  findFinding,
  memoEvaluator,
  textOnCanvas,
} from './theme-remediation-test-support.ts';
import {
  REMEDIATION_ALGORITHM_VERSION,
  candidateCss,
  lightnessOrder,
  measureAffected,
  readersOf,
  searchForeground,
  type SearchInput,
} from './theme-remediation.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';

// All runtime work happens once, at module scope.
const dimmedDraft = createDraft(dimmedText);
const dimmedRecord = await findFinding(dimmedText, textOnCanvas);
const dimmedProperties = await (async () => {
  const evaluation = await memoEvaluator.evaluate(dimmedText, 1, 'light/default');
  if (!evaluation.ok) throw new Error('The fixture must evaluate.');
  return Object.fromEntries(evaluation.properties.map(({ name, value }) => [name, value]));
})();
const dimmedSearch: SearchInput = {
  property: '--cinder-text-default',
  properties: dimmedProperties,
  pairings: CONTRAST_PAIRINGS,
  findingPairingId: 'text:default:canvas',
  theme: 'light',
  gamut: 'srgb',
};
const first = searchForeground(dimmedSearch);
const second = searchForeground(dimmedSearch);
const request = {
  draft: dimmedDraft,
  record: dimmedRecord,
  evaluator: memoEvaluator,
  gamut: 'srgb' as OutputGamut,
};
const proposed = await proposeForFinding(request);
const proposedAgain = await proposeForFinding(request);

const pairing = (id: string, overrides: Partial<ContrastPairing> = {}): ContrastPairing => ({
  id,
  group: 'text',
  classification: 'text',
  scope: 'wcag',
  criterion: '1.4.3',
  foreground: '--fg',
  background: `--bg-${id}`,
  description: `Foreground on ${id}`,
  ...overrides,
});

function synthetic(
  foreground: string,
  backgrounds: Record<string, string>,
  pairings: ContrastPairing[],
  gamut: OutputGamut = 'srgb',
): SearchInput {
  return {
    property: '--fg',
    properties: {
      '--fg': foreground,
      ...Object.fromEntries(
        Object.entries(backgrounds).map(([id, value]) => [`--bg-${id}`, value]),
      ),
    },
    pairings,
    findingPairingId: pairings[0]?.id ?? null,
    theme: 'light',
    gamut,
  };
}

describe('determinism and pinned Culori fixtures', () => {
  test('the same input returns byte-identical results', () => {
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(proposed.ok).toBe(true);
    expect(JSON.stringify(proposedAgain)).toBe(JSON.stringify(proposed));
  });

  test('the dimmed default text resolves to a pinned OKLCH literal', () => {
    if (!first.ok) throw new Error(first.message);
    expect(first.original).toEqual({ l: 0.93, c: 0.01, h: 245, alpha: 1 });
    expect(first.candidate).toEqual({ l: 0.529, c: 0.01, h: 245, alpha: 1 });
    expect(first.chromaStep).toBe(100);
    expect(first.gamut).toBe('srgb');
    expect(first.algorithmVersion).toBe(REMEDIATION_ALGORITHM_VERSION);
    expect(REMEDIATION_ALGORITHM_VERSION).toBe(
      'foreground-oklch-remediation/1+oklch-chroma-grid-101/1',
    );
    const canvas = first.results.find((result) => result.pairingId === 'text:default:canvas');
    expect(canvas?.ratio).toBeCloseTo(5.055802114224761, 9);
  });

  test('Culori conversions are pinned for sRGB and Display P3', () => {
    const expectChannels = (actual: number[], expected: number[]) => {
      for (const [index, value] of expected.entries()) {
        expect(actual[index]).toBeCloseTo(value, 12);
      }
    };
    expectChannels(
      targetChannels({ l: 0.54, c: 0.0089, h: 245 }, 'srgb'),
      [0.4176571135215498, 0.4364206727198109, 0.45325912616325287],
    );
    expectChannels(
      targetChannels({ l: 0.7, c: 0.2, h: 150 }, 'display-p3'),
      [0.31781305464512566, 0.736695877069667, 0.3791405946700318],
    );
    // The same color is outside sRGB (a negative red channel) but inside Display P3.
    expect(inOutputGamut({ l: 0.7, c: 0.2, h: 150 }, 'srgb')).toBe(false);
    expect(inOutputGamut({ l: 0.7, c: 0.2, h: 150 }, 'display-p3')).toBe(true);
  });
});

describe('the lightness grid and tie-breaking', () => {
  test('lightness is i/1000 plus the original, ordered by distance then lower first', () => {
    expect(lightnessOrder(0.5).slice(0, 5)).toEqual([0.5, 0.499, 0.501, 0.498, 0.502]);
    const off = lightnessOrder(0.9333);
    expect(off).toHaveLength(1002);
    expect(off[0]).toBe(0.9333);
    expect(off).toContain(0);
    expect(off).toContain(1);
    expect(new Set(lightnessOrder(0.5)).size).toBe(1001);
  });

  test('the search matches a brute-force oracle over the whole grid', () => {
    const input = synthetic('oklch(0.9 0.12 250)', { a: 'oklch(0.98 0 0)' }, [pairing('a')]);
    const result = searchForeground(input);
    if (!result.ok) throw new Error(result.message);
    const original = result.original;
    const passing: Array<{ l: number; step: number; c: number }> = [];
    for (const l of lightnessOrder(original.l)) {
      for (let step = 100; step >= 0; step -= 1) {
        const c = Math.round(((original.c * step) / 100) * 1e5) / 1e5;
        if (!inOutputGamut({ l: Math.round(l * 1e5) / 1e5, c, h: original.h }, 'srgb')) continue;
        const candidate = { l: Math.round(l * 1e5) / 1e5, c, h: original.h, alpha: 1 };
        const properties = { ...input.properties, '--fg': candidateCss(candidate) };
        if (measureAffected(pairing('a'), properties, 'light').status === 'pass') {
          passing.push({ l, step, c });
        }
      }
    }
    const key = (value: number) => Math.round(Math.abs(value - original.l) * 1e9);
    const best = passing.toSorted(
      (a, b) => key(a.l) - key(b.l) || b.step - a.step || a.l - b.l,
    )[0]!;
    expect(result.candidate.l).toBe(Math.round(best.l * 1e5) / 1e5);
    expect(result.candidate.c).toBe(best.c);
    expect(result.chromaStep).toBe(best.step);
  });

  test('hue and alpha are preserved and the output is an OKLCH literal', () => {
    const input = synthetic('oklch(0.9 0.08 250 / 0.9)', { a: 'oklch(0.98 0 0)' }, [pairing('a')]);
    const result = searchForeground(input);
    if (!result.ok) throw new Error(result.message);
    expect(result.candidate.h).toBe(250);
    expect(result.candidate.alpha).toBe(0.9);
    expect(candidateCss(result.candidate)).toMatch(/^oklch\([\d.]+ [\d.]+ 250 \/ 0.9\)$/);
  });
});

describe('gamut', () => {
  test.each(['srgb', 'display-p3'] as const)(
    'every %s channel is in 0 to 1 with nothing clipped',
    (gamut) => {
      const input = synthetic(
        'oklch(0.96 0.3 150)',
        { a: 'oklch(0.2 0 0)', b: 'oklch(0.3 0 0)' },
        [pairing('a'), pairing('b')],
        gamut,
      );
      const result = searchForeground(input);
      if (!result.ok) throw new Error(result.message);
      for (const channel of targetChannels(result.candidate, gamut)) {
        expect(channel).toBeGreaterThanOrEqual(-1e-9);
        expect(channel).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(result.gamut).toBe(gamut);
    },
  );
});

describe('every affected pairing', () => {
  const light = pairing('light', { description: 'Foreground on the light surface' });
  const pale = pairing('pale', { description: 'Foreground on the pale surface' });
  const surfaces = { light: 'oklch(0.98 0 0)', pale: 'oklch(0.8 0 0)' };

  test('a candidate that fixes only the finding is rejected for breaking another pairing', () => {
    const alone = searchForeground(synthetic('oklch(0.9 0.02 250)', surfaces, [light]));
    const together = searchForeground(synthetic('oklch(0.9 0.02 250)', surfaces, [light, pale]));
    if (!alone.ok || !together.ok) throw new Error('Both searches must find a candidate.');
    expect(alone.candidate.l).toBeGreaterThan(0.5);
    expect(together.candidate.l).toBeLessThan(alone.candidate.l);
    expect(together.results.map((result) => result.status)).toEqual(['pass', 'pass']);
    const properties = {
      ...synthetic('x', surfaces, []).properties,
      '--fg': candidateCss(together.candidate),
    };
    expect(measureAffected(light, properties, 'light').status).toBe('pass');
    expect(measureAffected(pale, properties, 'light').status).toBe('pass');
  });

  test('readers of the foreground through var() are affected pairings too', () => {
    const map = { '--fg': 'oklch(0.5 0 0)', '--icon': 'var(--fg)', '--other': 'oklch(0.1 0 0)' };
    expect([...readersOf(map, '--fg')].toSorted()).toEqual(['--fg', '--icon']);
  });

  test('no candidate explains which pairings cannot pass together', () => {
    const conflict = { light: 'oklch(0.98 0 0)', mid: 'oklch(0.5 0 0)', dark: 'oklch(0.05 0 0)' };
    const result = searchForeground(
      synthetic('oklch(0.9 0.02 250)', conflict, [
        pairing('light', { description: 'Text on light' }),
        pairing('dark', { description: 'Text on dark' }),
        pairing('mid', { description: 'Text on mid' }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-candidate');
    expect(result.message).toContain('no single color on the search grid passes all of them');
    expect(result.message).toContain('Text on light');
    expect(result.blockers.every((blocker) => blocker.reachableAlone)).toBe(true);
  });

  test('a pairing no color can satisfy is named with the best ratio reached', () => {
    const hard = pairing('hard', {
      scope: 'cinder-advisory',
      classification: 'decorative-separator',
      advisoryFloor: 8,
      description: 'Divider on mid gray',
    });
    const result = searchForeground(
      synthetic('oklch(0.9 0 0)', { hard: 'oklch(0.6 0 0)' }, [hard]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(
      /Divider on mid gray needs 8:1, and no color on the search grid in sRGB reaches more than \d\.\d\d:1/,
    );
    expect(result.blockers[0]?.reachableAlone).toBe(false);
  });

  test('an existing advisory failure may stay, but the finding pairing must pass', () => {
    const advisory = pairing('floor', {
      scope: 'cinder-advisory',
      classification: 'decorative-separator',
      advisoryFloor: 30,
      description: 'Unreachable advisory floor',
    });
    const result = searchForeground(
      synthetic('oklch(0.9 0.02 250)', { light: 'oklch(0.98 0 0)', floor: 'oklch(0.5 0 0)' }, [
        light,
        advisory,
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('what a finding offers', () => {
  test('a literal foreground gets "Replace value with OKLCH" with every changed path shown', () => {
    if (!proposed.ok) throw new Error(proposed.message);
    const { proposal } = proposed;
    expect(proposal.action).toBe('replace-oklch');
    expect(proposal.label).toBe('Replace value with OKLCH');
    expect(proposal.gamut).toBe('srgb');
    expect(proposal.algorithmVersion).toBe(REMEDIATION_ALGORITHM_VERSION);
    expect(proposal.binding).toMatchObject({
      revision: 1,
      target: 'text.default',
      context: 'light/default',
    });
    const target = proposal.changes.find((row) => row.role === 'target');
    expect(target?.path).toBe('text.default');
    expect(target?.before).toContain('oklch(0.93 0.01 245)');
    expect(target?.after).toContain('oklch(0.529 0.01 245)');
    const ratio = proposal.measurements.find((row) => row.pairingId === 'text:default:canvas');
    expect(ratio?.before).toBeLessThan(4.5);
    expect(ratio?.after).toBeGreaterThanOrEqual(4.5);
    expect(proposal.measurements.every((row) => row.status === 'pass')).toBe(true);
    expect(proposal.resolved).toBeGreaterThan(0);
  });

  test('only the foreground in the selected color mode changes', () => {
    if (!proposed.ok) throw new Error(proposed.message);
    const { state } = proposed.proposal;
    expect(state.overrides.dark).toEqual(dimmedText.overrides.dark);
    expect(state.overrides.shared).toEqual(dimmedText.overrides.shared);
    expect(state.cssOverrides).toEqual(dimmedText.cssOverrides);
    expect(JSON.stringify(state.overrides.light)).not.toBe(
      JSON.stringify(dimmedText.overrides.light),
    );
    expect(Object.keys(state.overrides.light)).toEqual(['text']);
  });

  test('a real-runtime evaluator and a fresh one agree on the property map', async () => {
    const fresh = await createRuntimeEvaluator().evaluate(dimmedText, 1, 'light/default');
    expect(fresh.ok).toBe(true);
  });
});
