// Type-level tripwire (COR-2199): a scorer speaks the validator outcome vocabulary and receives a
// signal, so a scorer that still has `evaluate`, or a score that still has `pass`, fails type-checking.
import type { PluginScore, PluginScoreOutcome, PluginScorer } from './index.ts';

const run = {} as Parameters<PluginScorer['score']>[0];

// The new shape is accepted: an outcome kind, a message and an optional score.
export const verdict: PluginScore = { outcome: 'pass', message: 'fine' };
export const scored: PluginScore = { outcome: 'fail', message: 'low', score: 0.2 };

export const scorer: PluginScorer = {
  name: 'judge',
  version: '1',
  determinism: 'stochastic',
  score: (_run, signal) => ({ outcome: signal.aborted ? 'canceled' : 'pass', message: '' }),
};

// A scorer may return the verdict asynchronously.
export const asynchronous: PluginScorer = {
  name: 'judge',
  version: '1',
  score: async () => ({ outcome: 'indeterminate', message: 'unsure' }),
};

// Every validator outcome kind is a score outcome, and nothing else is.
export const kinds: Record<PluginScoreOutcome, true> = {
  pass: true,
  fail: true,
  error: true,
  unavailable: true,
  canceled: true,
  indeterminate: true,
};

// @ts-expect-error -- `pass: boolean` was replaced by `outcome`
export const stalePass: PluginScore = { pass: true, score: 1, message: '' };

// @ts-expect-error -- an outcome is a validator outcome kind
export const unknownOutcome: PluginScore = { outcome: 'passed', message: '' };

// @ts-expect-error -- `outcome` is required
export const missingOutcome: PluginScore = { message: '', score: 1 };

export const staleEvaluate: PluginScorer = {
  name: 'judge',
  version: '1',
  // @ts-expect-error -- `evaluate` was replaced by `score`
  evaluate: () => ({ outcome: 'pass', message: '' }),
  score: () => ({ outcome: 'pass', message: '' }),
};

// @ts-expect-error -- `score` is required
export const missingScore: PluginScorer = { name: 'judge', version: '1' };

export const staleDeterminism: PluginScorer = {
  name: 'judge',
  version: '1',
  // @ts-expect-error -- `determinism` is `deterministic` or `stochastic`
  determinism: 'random',
  score: () => ({ outcome: 'pass', message: '' }),
};

// The digest is the host's, so a scorer cannot supply one.
export const suppliedDigest: PluginScorer = {
  name: 'judge',
  version: '1',
  // @ts-expect-error -- the digest is computed by the host from the name and version
  digest: 'abc',
  score: () => ({ outcome: 'pass', message: '' }),
};

// `score` takes the run and a signal.
export const callable: PluginScore | Promise<PluginScore> = scorer.score(
  run,
  new AbortController().signal,
);
