/**
 * Pure statistics for `measure-playground.ts` (CIN-585).
 *
 * Nothing here spawns a process, reads the clock, or touches the filesystem, so every rule the
 * decision document relies on — the median, the variability band, the candidate selection rule,
 * and the retained-resource growth classification — is unit-tested with fixed arrays.
 */

/** A sample was taken from fresh run-owned caches (`cold`) or immediately repeated (`warm`). */
export type Temperature = 'cold' | 'warm';

/** The three primary metrics CIN-585's selection rule weighs. */
export type PrimaryMetric =
  'staticExportMilliseconds' | 'serverSpawnToReadyMilliseconds' | 'processTreePeakResidentBytes';

/** Every sample plus the observed variability band and the median. */
export type SampleSummary = {
  samples: readonly number[];
  minimum: number;
  median: number;
  maximum: number;
};

function assertSamples(samples: readonly number[]): void {
  if (samples.length === 0) throw new RangeError('A summary needs at least one sample.');
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new RangeError(`Sample ${sample} is not a finite number.`);
  }
}

/** The middle sample, or the mean of the two middle samples for an even count. */
export function median(samples: readonly number[]): number {
  assertSamples(samples);
  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Summarize samples as their observed [minimum, maximum] band and median. */
export function summarize(samples: readonly number[]): SampleSummary {
  assertSamples(samples);
  return {
    samples: [...samples],
    minimum: Math.min(...samples),
    median: median(samples),
    maximum: Math.max(...samples),
  };
}

/** One primary metric at one temperature, sampled for the baseline and the candidate. */
export type MetricObservation = {
  metric: PrimaryMetric;
  /**
   * The measured child the metric was sampled from, when a metric is sampled from more than one
   * (process-tree peak resident memory is sampled for both the static export and the server).
   */
  subject?: string;
  temperature: Temperature;
  baseline: readonly number[];
  candidate: readonly number[];
};

export type MetricComparison = {
  key: string;
  baseline: SampleSummary;
  candidate: SampleSummary;
  /** The candidate's maximum is below the baseline's minimum: outside the baseline band. */
  improved: boolean;
  /** The candidate's median is no greater than the baseline's maximum. */
  withinBaseline: boolean;
};

export type SelectionDecision = {
  selected: boolean;
  comparisons: readonly MetricComparison[];
  reasons: readonly string[];
};

/**
 * Apply CIN-585's selection rule.
 *
 * Each primary metric is weighed separately cold and warm, so each (metric, temperature) pair is
 * one observation. A baseline's variability band is its observed [minimum, maximum]. The candidate
 * is selected only if at least one observation's candidate maximum is below that observation's
 * baseline minimum, while every other observation's candidate median is no greater than its
 * baseline maximum. Otherwise the baseline is retained. There is no percentage target.
 *
 * An improved observation always satisfies the median condition too (its candidate median is at
 * most its candidate maximum, which is below the baseline minimum), so the rule reduces to: some
 * observation improved, and no observation's candidate median exceeds its baseline maximum.
 */
export function selectCandidate(observations: readonly MetricObservation[]): SelectionDecision {
  if (observations.length === 0) throw new RangeError('The selection rule needs observations.');
  const seen = new Set<string>();
  const comparisons = observations.map((observation): MetricComparison => {
    const metric =
      observation.subject === undefined
        ? observation.metric
        : `${observation.metric}(${observation.subject})`;
    const key = `${metric}/${observation.temperature}`;
    if (seen.has(key)) throw new RangeError(`Observation ${key} appears more than once.`);
    seen.add(key);
    const baseline = summarize(observation.baseline);
    const candidate = summarize(observation.candidate);
    return {
      key,
      baseline,
      candidate,
      improved: candidate.maximum < baseline.minimum,
      withinBaseline: candidate.median <= baseline.maximum,
    };
  });

  const improved = comparisons.filter((comparison) => comparison.improved);
  const outside = comparisons.filter((comparison) => !comparison.withinBaseline);
  const reasons: string[] = [];
  if (improved.length === 0) {
    reasons.push('No primary metric has a candidate maximum below its baseline minimum.');
  }
  for (const comparison of improved) {
    reasons.push(
      `${comparison.key}: candidate maximum ${comparison.candidate.maximum} is below baseline minimum ${comparison.baseline.minimum}.`,
    );
  }
  for (const comparison of outside) {
    reasons.push(
      `${comparison.key}: candidate median ${comparison.candidate.median} exceeds baseline maximum ${comparison.baseline.maximum}.`,
    );
  }
  return { selected: improved.length > 0 && outside.length === 0, comparisons, reasons };
}

/**
 * How a retained-resource count moved across consecutive cycles.
 *
 * `monotonic-growth` means it never fell and ended above where it started: the shape a leak takes,
 * and the shape the decision must explain with owner evidence rather than call caching.
 * `stable` means every cycle held the same value. `fluctuating` covers everything else, including
 * growth that was later released.
 */
export type GrowthClassification = 'monotonic-growth' | 'stable' | 'fluctuating';

export function classifyGrowth(series: readonly number[]): GrowthClassification {
  assertSamples(series);
  if (series.length < 2) throw new RangeError('Growth needs at least two cycles.');
  const first = series[0]!;
  if (series.every((value) => value === first)) return 'stable';
  const neverFell = series.every((value, index) => index === 0 || value >= series[index - 1]!);
  return neverFell && series.at(-1)! > first ? 'monotonic-growth' : 'fluctuating';
}

export type GrowthReport = Record<
  string,
  { series: number[]; classification: GrowthClassification }
>;

/** Classify every named retained-resource series across the recorded cycles. */
export function growthReport(series: Record<string, number[]>): GrowthReport {
  return Object.fromEntries(
    Object.entries(series).map(([name, values]) => [
      name,
      { series: values, classification: values.length < 2 ? 'stable' : classifyGrowth(values) },
    ]),
  );
}

/** What the server's artifact owners retain after one edit settles. */
export type RetainedArtifacts = { totalArtifacts: number; totalArtifactBytes: number };

/**
 * After repeated edits of one example, retained artifact entries and bytes must match the first
 * settled edit exactly: each edit's superseded generation is released, so nothing accumulates.
 * Returns one problem per edit that differs; an empty list means retention stayed bounded.
 */
export function retainedArtifactProblems(edits: readonly RetainedArtifacts[]): string[] {
  if (edits.length < 2) throw new RangeError('Bounded retention needs at least two settled edits.');
  const [first] = edits as [RetainedArtifacts, ...RetainedArtifacts[]];
  return edits.flatMap((edit, index) =>
    index === 0 ||
    (edit.totalArtifacts === first.totalArtifacts &&
      edit.totalArtifactBytes === first.totalArtifactBytes)
      ? []
      : [
          `Edit ${index + 1} retained ${edit.totalArtifacts} artifacts and ${edit.totalArtifactBytes} bytes; the first settled edit retained ${first.totalArtifacts} and ${first.totalArtifactBytes}.`,
        ],
  );
}
