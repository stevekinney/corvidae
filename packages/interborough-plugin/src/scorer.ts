import type { RunResult, TokenUsage, ValidatorOutcome } from '@lostgradient/operative';

/**
 * How a scorer judged a run: the `kind` of an Operative `ValidatorOutcome`, the vocabulary a goal's
 * validator already speaks (`pass`, `fail`, `error`, `unavailable`, `canceled`, `indeterminate`).
 */
export type PluginScoreOutcome = ValidatorOutcome['kind'];

/**
 * A decision a scorer asked a model for while it scored (the `provider`, `model` and `usage` of an
 * Operative `Decision`). The host records it on the score's audit record, so the spend a scorer
 * made is on the same record as its verdict.
 */
export interface PluginScoreDecision {
  /** The provider that answered, such as `anthropic`. */
  provider: string;
  /** The provider-native model that answered. */
  model: string;
  /** Tokens the decision spent, when the provider reported them. */
  usage?: TokenUsage;
}

/** The result of scoring a single completed run against one scorer. */
export interface PluginScore {
  /**
   * How the scorer judged the run. Only `fail` raises an alert on its own. The host records
   * `error`, `unavailable` and `canceled` itself when a scorer throws, its plugin needs setup, or
   * its deadline passes, and a scorer may return any kind.
   */
  outcome: PluginScoreOutcome;
  /**
   * Human-readable description of the score. It is recorded on the audit record for an authorized
   * read and never sent in an alert, an event or a hook delivery.
   */
  message: string;
  /**
   * Score from 0 to 1 (1 = perfect), when the scorer measures one. A finite number outside that
   * range makes the whole score malformed. When the scorer has an `alertThreshold`, a score below
   * it raises an alert whatever the outcome is.
   */
  score?: number;
  /**
   * The decisions the scorer made while it scored, in the order it made them, when it made any.
   * They are recorded on the audit record beside the score and never sent in an alert or an event.
   * A list that is not an array of `{ provider, model, usage? }` with string names and a usage of
   * finite counts, or that holds more than 64 entries, makes the whole score malformed.
   */
  decisions?: readonly PluginScoreDecision[];
}

/**
 * A single configured scorer run against a fraction of live runs. `score` receives the completed
 * run's {@link RunResult}, so an offline matcher or model judge that already scores a `RunResult`
 * can be adapted into this shape directly: wrap it, normalize its score to 0-1, and return a
 * {@link PluginScore}.
 */
export interface PluginScorer {
  /** Name recorded on every audit record and alert payload produced by this scorer. */
  name: string;
  /**
   * The scorer's version (COR-1872), recorded beside its name on every audit record and alert
   * payload, so a score can be traced to the exact scorer that gave it.
   */
  version: string;
  /**
   * Whether the scorer gives the same answer for the same run, recorded beside every score. The
   * host never trusts it for more than a label, and ignores any other value.
   */
  determinism?: 'deterministic' | 'stochastic';
  /**
   * Scores a sampled run. May be async (for example a model call). `signal` aborts when the Bureau
   * shuts down and when this scorer has run for 30 seconds; a scorer that honors it stops its own
   * work, and one that ignores it is abandoned at the deadline and its late result discarded.
   * Throwing records an `error`, and a malformed return (not an object, an unknown `outcome`, a
   * `message` that is not a string, or a `score` that is not a finite number from 0 to 1) records
   * an `error` too. The scorer's digest is computed by the host from its name and version, never
   * supplied.
   */
  score: (run: RunResult, signal: AbortSignal) => PluginScore | Promise<PluginScore>;
  /**
   * Alert threshold: a score strictly below this fires a webhook, and so does a `fail` outcome
   * whatever its score. Without a threshold only `fail` alerts.
   */
  alertThreshold?: number;
  /**
   * The share of eligible runs this scorer scores, from 0 to 1, in place of the host's rate (the
   * `scorers.sampleRate` setting), while that rate is above 0. A host rate of 0 turns every scorer
   * off, whatever rate a scorer asks for, so this never makes a scorer run when the owner has not
   * turned scoring on. The scorer rolls for itself, so its rate does not depend on the other
   * scorers'. A value that is not a number from 0 to 1 is ignored and the host's rate applies.
   * Recorded beside every score as `sampleRate`.
   */
  sampleRate?: number;
}
