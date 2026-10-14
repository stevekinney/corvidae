/**
 * The deterministic foreground remediation search (COR-487). Pure: no DOM, no storage, no
 * randomness and no clock, so the same inputs produce the same bytes on every run.
 *
 * Only the foreground's color is searched. The background, every other property and every
 * other context are inputs and never change. A candidate is an OKLCH color with the original
 * hue and alpha. Lightness is enumerated as `i / 1000` for `i = 0 … 1000` plus the original
 * lightness; for each lightness the largest passing chroma on the shared 101-step grid
 * (`chromaGrid`, `originalChroma * j / 100`, `j = 100 … 0`) is taken, where "passing" means
 * every target RGB channel is in `[0, 1]` (no clipping) and EVERY affected known pairing
 * still passes after the candidate is composited. Candidates order by smallest absolute
 * lightness change, then smallest chroma reduction, then lower lightness.
 *
 * Culori (through `theme-chroma-grid.ts` and the shared runtime) is the only color engine.
 */

import {
  evaluateCssColor,
  measurePairing,
  requiredContrast,
  type ContrastPairing,
} from '@lostgradient/cinder/tokens/runtime';

import {
  CHROMA_GRID_VERSION,
  inOutputGamut,
  largestPassingChroma,
  type OutputGamut,
} from './theme-chroma-grid.ts';

/** Recorded in every proposal and report; a change to the search invalidates them. */
export const REMEDIATION_ALGORITHM_VERSION = `foreground-oklch-remediation/1+${CHROMA_GRID_VERSION}`;

export const LIGHTNESS_STEPS = 1000;

export type RemediationTheme = 'light' | 'dark';

export type OriginalForeground = { l: number; c: number; h: number; alpha: number };

/** The output color, rounded the way the DTCG literal is written, so what is measured is what ships. */
export type RemediationCandidate = { l: number; c: number; h: number; alpha: number };

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** The CSS text of a candidate, as the property map holds it while measuring. */
export function candidateCss(color: RemediationCandidate): string {
  const base = `oklch(${color.l} ${color.c} ${color.h}`;
  return color.alpha === 1 ? `${base})` : `${base} / ${color.alpha})`;
}

export type PairingStatus = 'pass' | 'fail' | 'review';

export type PairingResult = {
  pairingId: string;
  description: string;
  /** Scope of the rule: a WCAG threshold or a Cinder advisory floor. */
  scope: ContrastPairing['scope'];
  status: PairingStatus;
  ratio: number | null;
  required: number | null;
};

/** The pairing's threshold: WCAG's by classification, or Cinder's advisory floor. */
export function requiredFor(pairing: ContrastPairing): number | null {
  return pairing.scope === 'cinder-advisory'
    ? (pairing.advisoryFloor ?? null)
    : requiredContrast(pairing.classification);
}

export function measureAffected(
  pairing: ContrastPairing,
  properties: Readonly<Record<string, string>>,
  theme: RemediationTheme,
): PairingResult {
  const required = requiredFor(pairing);
  const measurement = measurePairing(pairing, properties, { theme });
  const base = {
    pairingId: pairing.id,
    description: pairing.description,
    scope: pairing.scope,
    required,
  };
  if (measurement.status === 'needs-review') {
    return { ...base, status: 'review', ratio: null };
  }
  const passes = required === null || measurement.ratio >= required;
  return { ...base, status: passes ? 'pass' : 'fail', ratio: measurement.ratio };
}

const VARIABLE_READ = /var\(\s*(--[\w-]+)/g;

/**
 * `property` and every property whose value reads it through `var()`, directly or through
 * another property. Substituting the candidate into the map therefore reaches every reader.
 */
export function readersOf(
  properties: Readonly<Record<string, string>>,
  property: string,
): ReadonlySet<string> {
  const closure = new Set<string>([property]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of Object.entries(properties)) {
      if (closure.has(name)) continue;
      for (const match of value.matchAll(VARIABLE_READ)) {
        if (closure.has(match[1]!)) {
          closure.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return closure;
}

/** The pairings that name any of `names` as foreground, background, backdrop or opacity. */
export function affectedPairings(
  pairings: readonly ContrastPairing[],
  names: ReadonlySet<string>,
): ContrastPairing[] {
  return pairings.filter(
    (pairing) =>
      names.has(pairing.foreground) ||
      names.has(pairing.background) ||
      (pairing.backdrop !== undefined && names.has(pairing.backdrop)),
  );
}

/** The foreground's OKLCH coordinates as the context's property map holds them. */
export function originalForeground(
  properties: Readonly<Record<string, string>>,
  property: string,
  theme: RemediationTheme,
): OriginalForeground | null {
  const value = properties[property];
  if (value === undefined) return null;
  const evaluated = evaluateCssColor(value, properties, { theme });
  if (!evaluated.ok) return null;
  const { l, c, h, alpha } = evaluated.color;
  return { l, c, h: h ?? 0, alpha };
}

/** Lightness candidates `i / 1000` plus the original, in search order: |ΔL|, then lower L. */
export function lightnessOrder(originalLightness: number): number[] {
  const values = new Set<number>([originalLightness]);
  for (let step = 0; step <= LIGHTNESS_STEPS; step += 1) values.add(step / LIGHTNESS_STEPS);
  const key = (value: number): number => Math.round(Math.abs(value - originalLightness) * 1e9);
  return [...values].toSorted((a, b) => key(a) - key(b) || a - b);
}

export type Blocker = {
  pairingId: string;
  description: string;
  required: number | null;
  /** The best ratio any in-gamut grid point reaches for this pairing alone, or `null`. */
  bestRatio: number | null;
  /** True when this pairing alone can pass somewhere on the grid. */
  reachableAlone: boolean;
};

export type SearchInput = {
  property: string;
  /** The selected context's evaluated property map; never mutated. */
  properties: Readonly<Record<string, string>>;
  pairings: readonly ContrastPairing[];
  /** The pairing the finding is about; it is checked first and must pass. */
  findingPairingId: string | null;
  theme: RemediationTheme;
  gamut: OutputGamut;
};

export type SearchResult =
  | {
      ok: true;
      original: OriginalForeground;
      candidate: RemediationCandidate;
      /** The chroma-grid step `j` the candidate came from; 100 keeps the original chroma. */
      chromaStep: number;
      deltaLightness: number;
      /** `original.c - candidate.c` before rounding to the stored precision. */
      chromaReduction: number;
      results: readonly PairingResult[];
      gamut: OutputGamut;
      algorithmVersion: string;
    }
  | {
      ok: false;
      reason: 'no-foreground' | 'no-candidate';
      message: string;
      blockers: readonly Blocker[];
      gamut: OutputGamut;
      algorithmVersion: string;
    };

type Plan = {
  affected: ContrastPairing[];
  /** Pairings measured before, keyed by id: a review stays a review, a pass must stay one. */
  before: Map<string, PairingResult>;
};

function planFor(input: SearchInput): Plan {
  const affected = affectedPairings(
    input.pairings,
    readersOf(input.properties, input.property),
  ).toSorted(
    (a, b) =>
      Number(b.id === input.findingPairingId) - Number(a.id === input.findingPairingId) ||
      a.id.localeCompare(b.id),
  );
  const before = new Map(
    affected.map((pairing) => [
      pairing.id,
      measureAffected(pairing, input.properties, input.theme),
    ]),
  );
  return { affected, before };
}

/** Every affected pairing must pass; an advisory floor only must not regress. */
function acceptable(
  result: PairingResult,
  before: PairingResult | undefined,
  mustPass: boolean,
): boolean {
  if (result.status === 'pass') return true;
  if (mustPass) return false;
  if (result.status === 'review') return before?.status === 'review';
  return result.scope === 'cinder-advisory' && before?.status === 'fail';
}

function roundedCandidate(
  l: number,
  c: number,
  original: OriginalForeground,
): RemediationCandidate {
  return { l: round(l, 5), c: round(c, 5), h: round(original.h, 3), alpha: original.alpha };
}

function evaluateCandidate(
  input: SearchInput,
  plan: Plan,
  candidate: RemediationCandidate,
  collect: PairingResult[] | null,
): boolean {
  const properties = { ...input.properties, [input.property]: candidateCss(candidate) };
  for (const pairing of plan.affected) {
    const result = measureAffected(pairing, properties, input.theme);
    if (!acceptable(result, plan.before.get(pairing.id), pairing.id === input.findingPairingId)) {
      return false;
    }
    collect?.push(result);
  }
  return true;
}

/** The probe points shared by every pairing: per lightness, the gray and the widest in-gamut chroma. */
function probePoints(input: SearchInput, original: OriginalForeground): RemediationCandidate[] {
  const points: RemediationCandidate[] = [];
  for (let step = 0; step <= LIGHTNESS_STEPS; step += 1) {
    const l = step / LIGHTNESS_STEPS;
    const widest = largestPassingChroma(l, original.h, original.c, input.gamut);
    for (const c of new Set([0, widest?.chroma ?? 0])) {
      points.push(roundedCandidate(l, c, original));
    }
  }
  return points;
}

/** The best ratio reachable for one pairing alone, over the probe points. */
function bestAlone(
  input: SearchInput,
  points: readonly RemediationCandidate[],
  pairing: ContrastPairing,
): Blocker {
  const required = requiredFor(pairing);
  let best: number | null = null;
  for (const candidate of points) {
    const properties = { ...input.properties, [input.property]: candidateCss(candidate) };
    const result = measureAffected(pairing, properties, input.theme);
    if (result.ratio !== null && (best === null || result.ratio > best)) best = result.ratio;
  }
  return {
    pairingId: pairing.id,
    description: pairing.description,
    required,
    bestRatio: best,
    reachableAlone: required === null || (best !== null && best >= required),
  };
}

/** Run the bounded search. Deterministic: the same input returns the same result. */
export function searchForeground(input: SearchInput): SearchResult {
  const base = { gamut: input.gamut, algorithmVersion: REMEDIATION_ALGORITHM_VERSION };
  const original = originalForeground(input.properties, input.property, input.theme);
  if (original === null) {
    return {
      ok: false,
      reason: 'no-foreground',
      message: `${input.property} is not a color this context can measure.`,
      blockers: [],
      ...base,
    };
  }
  const plan = planFor(input);
  let best: { l: number; c: number; step: number; delta: number } | null = null;
  for (const l of lightnessOrder(original.l)) {
    const delta = Math.round(Math.abs(l - original.l) * 1e9);
    // A larger |ΔL| can never beat a candidate found at a smaller one.
    if (best !== null && delta > best.delta) break;
    const found = largestPassingChroma(l, original.h, original.c, input.gamut, (color) => {
      if (!inOutputGamut({ l: round(color.l, 5), c: round(color.c, 5), h: color.h }, input.gamut)) {
        return false;
      }
      return evaluateCandidate(input, plan, roundedCandidate(color.l, color.c, original), null);
    });
    if (found === null) continue;
    const better =
      best === null ||
      found.step > best.step ||
      (found.step === best.step && delta === best.delta && l < best.l);
    if (better) best = { l, c: found.chroma, step: found.step, delta };
  }
  if (best === null) {
    const points = probePoints(input, original);
    const blockers = plan.affected.map((pairing) => bestAlone(input, points, pairing));
    return {
      ok: false,
      reason: 'no-candidate',
      message: blockerMessage(input.gamut, blockers),
      blockers,
      ...base,
    };
  }
  const candidate = roundedCandidate(best.l, best.c, original);
  const results: PairingResult[] = [];
  evaluateCandidate(input, plan, candidate, results);
  return {
    ok: true,
    original,
    candidate,
    chromaStep: best.step,
    deltaLightness: round(candidate.l - original.l, 5),
    chromaReduction: original.c - best.c,
    results,
    ...base,
  };
}

const ratio = (value: number | null): string => (value === null ? 'no ratio' : value.toFixed(2));

/** A specific explanation: which pairings cannot pass at all, or cannot pass together. */
export function blockerMessage(gamut: OutputGamut, blockers: readonly Blocker[]): string {
  const target = gamut === 'srgb' ? 'sRGB' : 'Display P3';
  const unreachable = blockers.filter((blocker) => !blocker.reachableAlone);
  if (unreachable.length > 0) {
    return unreachable
      .map(
        (blocker) =>
          `${blocker.description} needs ${blocker.required}:1, and no color on the search grid in ${target} reaches more than ${ratio(blocker.bestRatio)}:1 against its fixed background.`,
      )
      .join(' ');
  }
  const names = blockers.map((blocker) => blocker.description).join('; ');
  return `Each of these pairings can pass alone in ${target}, but no single color on the search grid passes all of them together: ${names}.`;
}
