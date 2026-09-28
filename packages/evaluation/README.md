# @lostgradient/evaluation

Scores completed [Operative](../operative/README.md) runs against a versioned evaluator configuration: typed multi-criterion rubrics, hard per-criterion gates, calibration examples for a model judge, and a digest that identifies the configuration exactly. On top of that it runs each case its declared number of times, reports distributions and uncertainty rather than one score, surfaces disagreement and infrastructure failure explicitly, and refuses to treat an unchecked held-out dataset, an uncalibrated judge, or a drifted judge revision as gate-eligible. It implements the evaluator configuration, result-class, inspection-surface, and held-out, repeated-trial, variance, drift, and calibration sections of the calibrated evaluator contract (COR-896).

`runTrials` is the only case executor. It adds no agent loop: each trial calls an Operative agent's `run()` and scores the result. Every run can be kept in an append-only, digest-verified history and inspected with a local `history` command; release gates build on both in later slices.

## Configuration

An evaluator configuration is plain data, validated by `evaluatorConfigurationSchema`. Every contract field is required and none is defaulted, because a release gate cites a configuration by identity and an implicit default would let two citations of "the same" configuration mean different things.

| Field | Meaning |
| --- | --- |
| `name`, `revision` | The human half of the evaluator identity. |
| `passThreshold` | The weighted total, in `[0, 1]`, a case must reach. |
| `criteria` | Named criteria, each with a `kind`, `description`, positive `weight`, and optional `hardThreshold` in `[0, 1]`. |
| `examples` | Calibration examples shown to a model judge. Never scored, and never allowed to share an id with a dataset case. |
| `referenceMaterial` | Rubric text, style guides, or policies, with their own `version`. |
| `judge` | `{ kind: 'deterministic' \| 'heuristic', name }`, or `{ kind: 'model', name, model, effort, tools }`. |
| `promptVersion`, `datasetVersion` | The judge prompt's version and the dataset's version. |
| `environment` | The fixture or harness `{ name, revision }` checks run against. |
| `budgets` | `{ costUsd, latencyMilliseconds }` per evaluation and per gate run. |
| `repetitions` | Trials per case. At least 1 for a deterministic judge and at least 2 for a model or heuristic judge, because one trial from a stochastic judge is never sufficient evidence. |
| `variancePolicy` | `{ name, version, minimumPassFraction, maximumIntervalWidth }`: how trials collapse into a decision. Required for a model or heuristic judge, with no default; optional for a deterministic one. Its `maximumIntervalWidth` must be reachable at `repetitions`, so it can never be narrower than the 95 percent Wilson interval of a unanimous result. |
| `resultSchemaVersion` | The case-evaluation shape this configuration emits (currently `1`). |
| `codeRevision` | The evaluated system's commit hash. |

`evaluatorIdentity(configuration)` returns `{ name, revision, digest }`, where `digest` is the SHA-256 of `canonicalJson(configuration)`: keys sorted at every depth, array order kept. Any single-field change moves the digest; key order never does.

## Criteria

| Kind | Scored by |
| --- | --- |
| `deterministic-assertion` | A caller predicate in `scorers.assertions`; `true` is 1, `false` is 0. |
| `heuristic` | A caller function in `scorers.heuristics` returning a number in `[0, 1]`. |
| `trajectory` | Built in. Reads `RunResultBase.steps`: calling any of `forbiddenTools` or never calling one of `requiredTools` scores 0. |
| `policy` | A caller check in `scorers.policies` that receives the `referenceMaterial` entry the criterion cites. |
| `model-judge` | One call per case to the injected Operative `GenerateFunction`. |

The rubric's weighted total is `Σ(weight × score) / Σ weight`. A criterion whose score is below its `hardThreshold` fails the case no matter what the weighted total is.

## Evaluating a case

```ts
import { createEvaluator, toGeneratorProjection } from '@lostgradient/evaluation';

const evaluator = await createEvaluator({
  configuration,
  dataset: {
    id: 'capitals',
    version: 'capitals-2026-09',
    owner: 'evaluation-datasets-team',
    cases: [{ id: 'france', input, expected, visibility: 'held-out' }],
  },
  scorers: {
    assertions: {
      'names-the-capital': ({ result, evaluationCase }) =>
        result.content.includes(evaluationCase.expected),
    },
  },
  generate: judgeProvider, // required only for model-judge criteria
});

const evaluation = await evaluator.evaluateCase('france', runResult);
```

`createEvaluator` rejects, with an `EvaluatorConfigurationError` naming each issue path, an invalid configuration or dataset, a dataset version other than `datasetVersion`, a calibration example id that equals a case id, a criterion without a scorer (or a scorer without a criterion), and model-judge criteria without a `generate` function. The model judge never constructs a provider: configure the injected function for `judge.model` and `judge.effort`, and drive it with `createScriptedGenerate` in tests.

`evaluateCase` returns one of four verdicts:

- `pass` or `fail`: the run finished with `stop-condition` and the rubric passed or failed.
- `agent-failed`: the run finished with any other `finishReason`. No criterion is scored.
- `infrastructure-failure`: a scorer or the judge threw, returned a malformed score, or the evaluation exceeded `budgets.perEvaluation.latencyMilliseconds`. It carries a typed `EvaluatorInfrastructureError` and no rubric, so it can never be read as a pass or a fail.

## Repeated trials

```ts
import { runTrials } from '@lostgradient/evaluation';

const aggregate = await runTrials({
  evaluator,
  caseId: 'france',
  // Called once per trial; seed the agent's provider or runtime from `seed`.
  subject: ({ seed }) => createAgent({ name: 'geographer', generate }),
  runtime, // RuntimeServices; each trial's seed comes from runtime.random
});
```

`runTrials` calls the subject's `run()` with the case input exactly `repetitions` times, in order, and never retries. Each trial records its seed, finish reason, per-criterion results, weighted total, usage, cost estimate, feedback, and any typed infrastructure error. Seeds are drawn from the injected `runtime.random` before the first trial; pass `seeds` from an earlier aggregate to replay them. With the same seeds and the same scripted agent and judge, `JSON.stringify(aggregate)` is byte-identical.

The aggregate reports statistics rather than one score:

- `statistics.verdicts`: trials, passes, pass fraction, and the 95 percent Wilson score interval, over every trial that produced a verdict. An `agent-failed` trial counts as not passing.
- `statistics.criteria`: per criterion, over the scored trials, the same plus the mean score, the Bessel-corrected sample variance, and the standard deviation. A trial passes a criterion when its score reaches the criterion's hard threshold, or the configuration's pass threshold when it has none. A statistic that needs more trials than there are is `null`, never `0`.

Its `outcome` is never a collapsed pass boolean:

- `indeterminate` when any trial hit an infrastructure failure, including a run that rejected instead of finishing (`subject-error`). The typed errors are in `errors`.
- `pass` or `fail` when every trial agrees.
- For a split, `pass` only when the pass fraction reaches `minimumPassFraction` and the interval is no wider than `maximumIntervalWidth`; otherwise `disagreement`, with the thresholds it missed and the per-trial verdicts in `disagreement`. Without a variance policy, any split is `disagreement`.

`reconcileJudges([first, second])` compares two or more judges' aggregates for the same case, dataset version, and code revision: any `indeterminate` stays indeterminate, a shared `pass` or `fail` is kept, and anything else is `disagreement`.

## Held-out datasets

Every dataset has an `id`, a `version`, and an `owner`, and every case declares `visibility: 'held-out' | 'public'` with no default.

- `isGateEligibleDataset({ dataset, codeRevision, contaminationChecks })` is true only when the owner has recorded a contamination check (`{ datasetId, datasetVersion, codeRevision, actor, recordedAt, statement }`, parsed with `parseContaminationCheck`) for that dataset, version, and exact code revision.
- `promoteCaseToPublic({ dataset, caseId, principal, version })` returns a new dataset version with the case made public. Any principal other than the owner gets a `DatasetOwnershipError`, and the new version must differ from the old one, so a contamination check never covers two different held-out pools.

## Judge drift and calibration

- `judgeRevisionOf(configuration)` returns `{ name, promptVersion, digest }`, where `digest` covers exactly what the judge reads: the judge, the prompt version, the model-judge criteria, the reference material, and the calibration examples.
- `checkJudgeDrift({ configuration, generate }, calibrationSet)` rescores a fixed calibration set (`{ id, version, tolerance, minimumAgreementRate, items }`, each item carrying a human reference score per model-judge criterion) once per item. It is `passed` when enough scores fall within `tolerance` of the reference, `drifted` when they do not, and `indeterminate` when the judge failed on any item.
- `isGateEligibleJudge({ judgeRevision, driftChecks, calibrationRecords })` is true only when that exact revision digest has a passing drift check, no drift check that found drift, and a human `CalibrationRecord` (`{ judgeRevision, reviewer, sampleSize, agreementRate, recordedAt }`). Eligibility is per revision, so the prior approved revision stays eligible when a new one fails its drift check.

`src/fixtures/judge-drift/` holds a calibration set and scripted judge outputs for a stable revision, which passes, and a drifted revision, which does not.

## Projections

- `toReviewerProjection(evaluation)` is plain JSON with every inspectable fact: identity, configuration (including protected prompt material and reference material), the case with its expected answer and visibility, the rubric, unredacted feedback, the tool trajectory, usage, cost, the terminal reason, and any infrastructure error. It is for human calibrators and audit records. A trial aggregate is reviewer material in the same sense.
- `toGeneratorProjection(evaluation)` is what may go back to the evaluated system: the verdict, the feedback text, and the names of failing hard criteria. The feedback has a held-out case's id, the expected answer, every reference material text, and every calibration response removed, because a model judge may quote them.
- `toGeneratorProjection(aggregate)` gives the outcome, a feedback line built only from trial counts, and the names of hard criteria that failed in any trial. It never contains a case id, a held-out status, or an expected answer.

## History

```ts
import { BunSQLiteStorage, textValueStore } from '@lostgradient/weft';
import { createEvaluationHistory, toEvaluationRunRecord } from '@lostgradient/evaluation';

const store = textValueStore(new BunSQLiteStorage('.cache/evaluation-history.sqlite'));
const history = createEvaluationHistory(store);

const { digest } = await history.append(
  toEvaluationRunRecord({
    id: 'capitals-2026-09-28',
    recordedAt: new Date().toISOString(),
    evaluator,
    aggregates, // one runTrials aggregate per case
    latencyMilliseconds,
  }),
);
```

`createEvaluationHistory(store)` takes a weft `ConditionalTextValueStore` (`textValueStore` over `BunSQLiteStorage` for the local file, or over `MemoryStorage` in tests) and returns exactly `{ append, read, list }`. There is no update and no delete: historical results are never rewritten, and rolling an evaluator back means citing an earlier record.

- `append(record)` commits with a compare-and-swap that requires the id to be absent. A second record with the same id rejects with `HistoricalRecordExistsError`, and the first stays byte-identical.
- `read(id)` resolves the verified `{ digest, record }`, or `undefined` for an unknown id.
- `list()` resolves every verified record, oldest first.

Each stored row is the canonical JSON of `{ digest, record }`, where `digest` is the SHA-256 of the record's own canonical JSON. `read` and `list` reject with `CorruptHistoricalRecordError` when a row is not valid UTF-8, does not parse, is not in canonical form, does not match the record schema, is stored under another id, or does not match its digest, so changing any one byte of a row makes it unreadable rather than silently different.

`toEvaluationRunRecord` builds an `evaluation-run` record (schema version 1) from `runTrials` aggregates: the evaluator identity, dataset id and version, code revision, repetitions, variance policy, outcome counts, verdict and per-criterion statistics pooled over every trial, the summed cost (`null` when any trial has no cost estimate), the latency, and each case with its own statistics and per-trial seeds, verdicts, finish reasons, usage, cost, criterion scores, and typed error reasons. It rejects an aggregate from another evaluator, a case outside the evaluator's dataset, and a case aggregated twice.

A record never holds anything that could leak a held-out case. A held-out case is recorded by its ordinal in the dataset version, never by its id, and the schema rejects a held-out case that carries one. No expected answer, run content, feedback, judge rationale, or error message is stored, because each may quote one.

`compareEvaluationRuns(baseline, candidate)` reports, per criterion, the pass-fraction and mean-score deltas (`candidate - baseline`), plus the pooled verdict pass fraction, cost, and latency. A metric either run lacks has a `null` delta, never `0`.

The `history` command inspects the history and never writes to it:

```bash
bun run --cwd packages/evaluation history list [--store <path>]
bun run --cwd packages/evaluation history show <recordId> [--store <path>]
bun run --cwd packages/evaluation history compare <baselineRecordId> <candidateRecordId> [--store <path>]
```

`list` prints one JSON line per record; `show` and `compare` print one JSON document. Diagnostics go to stderr. It exits `0` on success, `64` on a usage error or an unknown record, and `65` on a corrupt record. `--store` defaults to `packages/evaluation/.cache/evaluation-history.sqlite`, which the repository ignores, and a store file that does not exist reads as an empty history without being created.

## Goal-controller adapter

A goal controller judges each finished attempt through `createGoalEvaluatorAdapter`, which returns a verdict in the validator vocabulary of COR-638 (managed goal and validation semantics). This package never imports a goal-controller type: the adapter is the whole interface.

```ts
import { createEvaluator, createGoalEvaluatorAdapter } from '@lostgradient/evaluation';

const evaluator = createEvaluator({ configuration, dataset, scorers, generate });
const evaluateAttempt = createGoalEvaluatorAdapter({
  configuration: {
    loadEvaluator: () => evaluator, // called once per verdict
    caseId: 'france', // the dataset case that states the goal
    retryableOnFailure: true, // required; there is no default retry
    nonRetryableCriteria: ['no-web-search'], // hard criteria whose failure is final
  },
  history,
});

const verdict = await evaluateAttempt(runResult, { signal });
```

Each call runs the case through `runTrials` with a subject that replays the attempt's `RunResult`, so the attempt is judged exactly `repetitions` times and never retried. The verdict's `kind` is exactly COR-638's `ValidatorOutcome` kind union, and an error's `kind` is exactly its `ValidatorErrorKind`; `src/goal-adapter.test-d.ts` holds both equalities at compile time.

| Verdict | When |
| --- | --- |
| `pass`, `fail` | The trial aggregate passed or failed. A `fail` is `retryable` only when `retryableOnFailure` is true and no hard criterion in `nonRetryableCriteria` failed. |
| `indeterminate` | The trials disagreed past the variance policy. |
| `error` | Any trial hit an evaluator infrastructure failure (`execute`, `timeout`, or `output`, from its typed reason), or the evaluation's record could not be appended (`execute`, `history-unwritable`). Never a pass or a fail. |
| `unavailable` | The evaluator never started: `loadEvaluator` rejected (`load`), or the configuration names a case or non-retryable criterion the evaluator lacks (`contract`). |
| `canceled` | `signal` aborted. The trial in flight finishes, later trials never score the attempt, and nothing is recorded. |

Every `pass`, `fail`, and `indeterminate` verdict, and every `error` from a trial, names the `evaluation-run` record it appended in `evidenceReference`, so `history.read(verdict.evidenceReference)` returns that evidence. `feedback` is exactly `toGeneratorProjection(aggregate).feedback`, built from trial counts alone, so no expected answer, reference material, held-out case id, criterion weight, or judge identity can reach the next attempt. Error messages are built from typed reasons and names; the raw failure is on `error.cause`, for reviewers only.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/evaluation
bun run --filter=@lostgradient/evaluation test:coverage
bun run --cwd packages/evaluation history list
```

`test:coverage` fails below 100 percent line or function coverage of this workspace's `src/` and `scripts/`.
