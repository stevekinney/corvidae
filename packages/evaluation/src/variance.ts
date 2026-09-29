/**
 * Variance and confidence reporting for repeated trials (COR-896, "repeated
 * trials" and "variance/confidence policy"). A stochastic judge never
 * produces one magic score: the trials of a case are reported as a
 * distribution, with the uncertainty of the pass fraction made explicit.
 *
 * - {@link summarizeProportion} gives a pass count, pass fraction, and the
 *   95 percent Wilson score interval around it.
 * - {@link summarizeScores} adds the mean score, the Bessel-corrected sample
 *   variance, and the standard deviation.
 *
 * Nothing is invented for missing evidence: a statistic that needs more
 * trials than there are is `null`, never `0`. One trial has no sample
 * variance, and zero trials have no pass fraction.
 *
 * The {@link VariancePolicy} is the named, versioned rule a configuration
 * declares for collapsing trials into a decision. It has no default; the
 * configuration schema requires one for every stochastic judge.
 */
import { z } from 'zod';

/** The two-sided 95 percent quantile of the standard normal distribution. */
export const WILSON_Z_95 = 1.959963984540054;

const fraction = z.number().gt(0).max(1);

export const variancePolicySchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  /** The share of trials that must pass, in `(0, 1]`. */
  minimumPassFraction: fraction,
  /** The widest 95 percent Wilson interval around the pass fraction that still decides, in `(0, 1]`. */
  maximumIntervalWidth: fraction,
});

export type VariancePolicy = z.output<typeof variancePolicySchema>;

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
}

/** One trial's contribution to a criterion's statistics. */
export interface TrialSample {
  readonly score: number;
  readonly passed: boolean;
}

export interface TrialStatistics {
  readonly trials: number;
  readonly passes: number;
  /** `passes / trials`; `null` without trials. */
  readonly passFraction: number | null;
  /** The 95 percent Wilson score interval around `passFraction`; `null` without trials. */
  readonly wilsonInterval: WilsonInterval | null;
}

export interface ScoreStatistics extends TrialStatistics {
  /** `null` without trials. */
  readonly meanScore: number | null;
  /** Bessel-corrected (`n - 1`); `null` below two trials. */
  readonly sampleVariance: number | null;
  /** The square root of `sampleVariance`; `null` below two trials. */
  readonly standardDeviation: number | null;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The 95 percent Wilson score interval for `passes` successes out of `trials`. */
export function wilsonInterval(passes: number, trials: number): WilsonInterval {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new RangeError(
      `A Wilson interval needs a positive whole number of trials, not ${trials}`,
    );
  }
  if (!Number.isInteger(passes) || passes < 0 || passes > trials) {
    throw new RangeError(`Expected between 0 and ${trials} passes, not ${passes}`);
  }
  const proportion = passes / trials;
  const zSquared = WILSON_Z_95 * WILSON_Z_95;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const halfWidth =
    (WILSON_Z_95 / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + zSquared / (4 * trials * trials));
  const lower = clampUnit(center - halfWidth);
  const upper = clampUnit(center + halfWidth);
  return { lower, upper, width: upper - lower };
}

/**
 * The narrowest interval `trials` trials can produce. A unanimous result is
 * the narrowest, so a policy whose `maximumIntervalWidth` is below this can
 * never be met at that trial count.
 */
export function narrowestIntervalWidth(trials: number): number {
  return wilsonInterval(trials, trials).width;
}

export function summarizeProportion(passes: number, trials: number): TrialStatistics {
  if (trials === 0) return { trials, passes, passFraction: null, wilsonInterval: null };
  return {
    trials,
    passes,
    passFraction: passes / trials,
    wilsonInterval: wilsonInterval(passes, trials),
  };
}

export function summarizeScores(samples: readonly TrialSample[]): ScoreStatistics {
  const trials = samples.length;
  const passes = samples.filter((sample) => sample.passed).length;
  const proportion = summarizeProportion(passes, trials);
  if (trials === 0) {
    return { ...proportion, meanScore: null, sampleVariance: null, standardDeviation: null };
  }
  const meanScore = samples.reduce((sum, sample) => sum + sample.score, 0) / trials;
  if (trials === 1) {
    return { ...proportion, meanScore, sampleVariance: null, standardDeviation: null };
  }
  const sampleVariance =
    samples.reduce((sum, sample) => sum + (sample.score - meanScore) ** 2, 0) / (trials - 1);
  return {
    ...proportion,
    meanScore,
    sampleVariance,
    standardDeviation: Math.sqrt(sampleVariance),
  };
}
