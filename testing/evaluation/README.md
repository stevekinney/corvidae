# @lostgradient/evaluation

Scores completed [Operative](../../packages/operative/README.md) runs against a versioned evaluator configuration: typed multi-criterion rubrics, hard per-criterion gates, calibration examples for a model judge, and a digest that identifies the configuration exactly. On top of that it runs each case its declared number of times, reports distributions and uncertainty rather than one score, surfaces disagreement and infrastructure failure explicitly, and refuses to treat an unchecked held-out dataset, an uncalibrated judge, or a drifted judge revision as gate-eligible. It implements the evaluator configuration, result-class, inspection-surface, and held-out, repeated-trial, variance, drift, and calibration sections of the calibrated evaluator contract (COR-896).

`runTrials` is the only case executor. It adds no agent loop: each trial calls an Operative agent's `run()` and scores the result. Every run can be kept in an append-only, digest-verified history and inspected with a local `history` command. A local `release-gate` command decides whether an evaluator's current evidence clears a gate against an explicit baseline, `replay` recomputes any stored decision from its recorded evidence without calling a model, and `promotion-signal` turns a passing decision into attributed evidence that binds exactly what was evaluated. A local `comparison` command runs one task three ways (one strong Agent, a compute-matched independent ensemble, and a `CollaborationPlan`-governed collaboration) and decides, under a predeclared rule, whether the collaboration is admitted (COR-818, against COR-820's collaboration decision). The memory-lifecycle suite, run with the `memory-lifecycle` command, uses all of these to compare memory architectures by the actions they lead to (see [Memory lifecycle evaluation](#memory-lifecycle-evaluation)).

## Workspace usage

Evaluation is verification tooling, so it lives under `testing/`, and a workspace may declare `"@lostgradient/evaluation": "workspace:*"` only in its `devDependencies`; `scripts/workspace-contract.test.ts` refuses a runtime edge to it. Install from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@lostgradient/evaluation`; the consumer compiles it. Its dependencies include `@lostgradient/operative`, for run results and the judge's `GenerateFunction`, `@lostgradient/weft`, for history storage, and `@lostgradient/memory`, whose stores the memory-lifecycle baselines wrap.

## Quick start

This evaluator scores one held-out case with a deterministic assertion and a built-in trajectory check. A scripted Operative agent stands in for a provider, so the example runs offline:

```ts
import { createEvaluator, runTrials, toGeneratorProjection } from '@lostgradient/evaluation';
import { createAgent, createScriptedGenerate } from '@lostgradient/operative';

const evaluator = await createEvaluator({
  configuration: {
    name: 'capitals',
    revision: 1,
    passThreshold: 0.75,
    criteria: [
      {
        name: 'names-the-capital',
        kind: 'deterministic-assertion',
        description: 'The final answer names the expected capital.',
        weight: 3,
        hardThreshold: 1,
      },
      {
        name: 'no-web-search',
        kind: 'trajectory',
        description: 'The agent answers without searching the web.',
        weight: 1,
        hardThreshold: 1,
        forbiddenTools: ['web_search'],
        requiredTools: [],
      },
    ],
    examples: [],
    referenceMaterial: { version: 'none', entries: [] },
    judge: { kind: 'deterministic', name: 'capital-checks' },
    promptVersion: 'none',
    datasetVersion: 'capitals-2026-09',
    environment: { name: 'scripted-generate', revision: '1' },
    budgets: {
      perEvaluation: { costUsd: 0, latencyMilliseconds: 5_000 },
      perGateRun: { costUsd: 0, latencyMilliseconds: 60_000 },
    },
    repetitions: 2,
    resultSchemaVersion: 1,
    codeRevision: 'dbf15fc4',
  },
  dataset: {
    id: 'capitals',
    version: 'capitals-2026-09',
    owner: 'evaluation-datasets-team',
    cases: [
      {
        id: 'france',
        input: 'What is the capital of France?',
        expected: 'Paris',
        visibility: 'held-out',
      },
    ],
  },
  scorers: {
    assertions: {
      'names-the-capital': ({ result, evaluationCase }) =>
        result.content.includes(evaluationCase.expected),
    },
  },
});

// A scripted agent stands in for a provider. Swap in a real `generate` to evaluate a model.
function geographer(answer: string) {
  return createAgent({
    name: 'geographer',
    generate: createScriptedGenerate([
      { kind: 'respond', response: { content: answer, toolCalls: [] } },
    ]),
  });
}

// One run, one verdict.
const run = await geographer('Lyon, on the Rhone.').run('What is the capital of France?').result();
const evaluation = await evaluator.evaluateCase('france', run);
console.log(evaluation.verdict); // 'fail'
console.log(toGeneratorProjection(evaluation));
// { projection: 'generator', verdict: 'fail',
//   feedback: 'Failed hard criteria: names-the-capital.', failedHardCriteria: ['names-the-capital'] }

// The same case, `repetitions` times, aggregated.
const aggregate = await runTrials({
  evaluator,
  caseId: 'france',
  subject: () => geographer('Paris, on the Seine.'),
});
console.log(aggregate.outcome); // 'pass'
console.log(aggregate.statistics.verdicts.passes, aggregate.statistics.verdicts.trials); // 2 2
console.log(toGeneratorProjection(aggregate).feedback); // '2 of 2 trials passed.'
```

The expected output is in the comments. The generator projection names the failing hard criterion but never the expected answer. A model-judged evaluator adds `model-judge` criteria, a `{ kind: 'model', ... }` judge, a `variancePolicy`, and a `generate` function for the judge; see [The model judge](#the-model-judge).

## Configuration

An evaluator configuration is plain data, validated by `evaluatorConfigurationSchema` (`parseEvaluatorConfiguration` throws an `EvaluatorConfigurationError` whose `issues` name each failing path). Every contract field is required and none is defaulted, because a release gate cites a configuration by identity and an implicit default would let two citations of "the same" configuration mean different things. Unknown keys are rejected at every level.

| Field | Meaning |
| --- | --- |
| `name`, `revision` | The human half of the evaluator identity. `revision` is a positive integer. |
| `passThreshold` | The weighted total, in `[0, 1]`, a case must reach. |
| `criteria` | At least one named criterion, each with a `kind`, `description`, positive `weight`, and optional `hardThreshold` in `[0, 1]`. Names are unique. See [Criteria](#criteria) for the fields each kind adds. |
| `examples` | Calibration examples shown to a model judge: `{ id, input, response, verdict: 'pass' \| 'fail', rationale }`. Never scored, and never allowed to share an id with a dataset case. |
| `referenceMaterial` | `{ version, entries: [{ id, title, text }] }`: rubric text, style guides, or policies, versioned apart from the criteria. |
| `judge` | `{ kind: 'deterministic' \| 'heuristic', name }`, or `{ kind: 'model', name, model, effort, tools }`. `effort` is Operative's `Effort` (`low`, `medium`, `high`, `xhigh`, `max`). |
| `promptVersion`, `datasetVersion` | The judge prompt's version and the dataset's version. `createEvaluator` rejects a dataset whose `version` differs. |
| `environment` | The fixture or harness `{ name, revision }` checks run against. |
| `budgets` | `{ perEvaluation: { costUsd, latencyMilliseconds }, perGateRun: { costUsd, latencyMilliseconds } }`. Only `perEvaluation.latencyMilliseconds` is enforced (see [What this package does not do](#what-this-package-does-not-do)). |
| `repetitions` | Trials per case. At least 1 for a deterministic judge and at least 2 for a model or heuristic judge, because one trial from a stochastic judge is never sufficient evidence. |
| `variancePolicy` | `{ name, version, minimumPassFraction, maximumIntervalWidth }`: how trials collapse into a decision. Required for a model or heuristic judge, with no default; optional for a deterministic one. Its `maximumIntervalWidth` must be reachable at `repetitions`, so it can never be narrower than the 95 percent Wilson interval of a unanimous result. |
| `resultSchemaVersion` | The case-evaluation shape this configuration emits. `createEvaluator` accepts only `EVALUATION_RESULT_SCHEMA_VERSION` (`1`). |
| `codeRevision` | The evaluated system's commit hash: 7 to 64 lowercase hexadecimal characters. |

`evaluatorIdentity(configuration)` resolves `{ name, revision, digest }`, where `digest` is the SHA-256 of `canonicalJson(configuration)`: keys sorted at every depth, `undefined` members dropped, array order kept. Any single-field change moves the digest; key order never does.

## Criteria

| Kind | Extra fields | Scored by |
| --- | --- | --- |
| `deterministic-assertion` | none | A caller predicate in `scorers.assertions`; `true` is 1, `false` is 0. |
| `heuristic` | none | A caller function in `scorers.heuristics` returning a number in `[0, 1]`. |
| `trajectory` | `forbiddenTools`, `requiredTools` (both required arrays) | Built in. Reads `RunResultBase.steps`: calling any of `forbiddenTools` or never calling one of `requiredTools` scores 0. |
| `policy` | `referenceMaterialId` | A caller check in `scorers.policies` that receives the `referenceMaterial` entry the criterion cites and returns a boolean or a number in `[0, 1]`. |
| `model-judge` | none | The case's single model-judge verdict. Requires a `model` judge. |

Scorers may be async and receive `{ evaluationCase, result, signal }`, where `evaluationCase` includes the expected answer and `signal` aborts when the evaluation exceeds its latency budget. A scorer that throws is a `scorer-error`, and one that returns the wrong type or a number outside `[0, 1]` is a `scorer-malformed-output`: both are infrastructure failures, never a low score.

`applyRubric(scores, passThreshold)` computes the rubric: the weighted total is `Σ(weight × score) / Σ weight`, and a criterion whose score is below its `hardThreshold` fails the case no matter what the weighted total is.

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

`createEvaluator` rejects, with an `EvaluatorConfigurationError` naming each issue path, an invalid configuration or dataset, a dataset version other than `datasetVersion`, a calibration example id that equals a case id, a criterion without a scorer (or a scorer without a criterion), a `resultSchemaVersion` other than `1`, model-judge criteria without a `generate` function, and both `generate` and `recordedJudgeOutput` at once. The resolved `Evaluator` exposes `identity`, the parsed `configuration` and `dataset`, and `evaluateCase(caseId, result)`, which throws a `RangeError` for a case id the dataset lacks. `timers` replaces the real clock for the latency budget in tests.

`evaluateCase` never starts a run: it scores exactly the `RunResultBase` it is given and returns one of four verdicts.

- `pass` or `fail`: the run finished with `stop-condition` and the rubric passed or failed. The evaluation carries the `rubric` and `feedback`: the model judge's feedback when a model judge scored the case, otherwise a one-line summary of the rubric.
- `agent-failed`: the run finished with any other `finishReason` (`AGENT_FAILURE_REASONS`). No criterion is scored.
- `infrastructure-failure`: a scorer or the judge threw, returned a malformed score, or the evaluation exceeded `budgets.perEvaluation.latencyMilliseconds`. It carries a typed `EvaluatorInfrastructureError` (`reason` from `INFRASTRUCTURE_FAILURE_REASONS`, plus the `criterion` when there was one) and no rubric, so it can never be read as a pass or a fail.

### The model judge

The judge calls the injected Operative `GenerateFunction` at most once per case, however many `model-judge` criteria there are. It never constructs a provider: configure the injected function for `judge.model` and `judge.effort` yourself, and drive it with `createScriptedGenerate` in tests.

- `renderJudgePrompt({ configuration, evaluationCase, result })` returns the `{ system, user }` prompt. The system message holds the model-judge rubric, the reference material, and the calibration examples; the user message holds the one case being scored, including its expected answer, the agent's final response, and its tool trajectory.
- The request carries `responseFormat: JUDGE_RESPONSE_FORMAT`, a JSON schema for `judgeResponseSchema`. The reply's `content` must be exactly `{"criteria":[{"name","score","rationale"}],"feedback"}` with one entry per model-judge criterion. A reply that is not JSON, fails the schema, scores an unknown or duplicate criterion, omits a criterion, or requests tool calls is `judge-malformed-output`; a throw is `judge-error`.
- `recordedJudgeOutput` replaces `generate` with a recorded `RecordedJudgeOutput` (`{ kind: 'reply', content, requestedTools }` or `{ kind: 'error' }`), read through the same checks. The release gate's replay scores model-judge criteria this way.

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

`runTrials` calls the subject's `run()` with the case input exactly `repetitions` times, in order, and never retries. Each trial records its seed, finish reason, per-criterion results, weighted total, usage, cost estimate, feedback, and any typed infrastructure error. Seeds are unsigned 32-bit integers drawn from the injected `runtime.random` (the real globals when omitted) before the first trial; pass `seeds` from an earlier aggregate to replay them, one per repetition, or get a `RangeError`. With the same seeds and the same scripted agent and judge, `JSON.stringify(aggregate)` is byte-identical. `scoreTrials` is the same executor with a `runResult(context, input)` callback in place of `subject`, for results produced some other way.

The aggregate reports statistics rather than one score:

- `statistics.verdicts`: trials, passes, pass fraction, and the 95 percent Wilson score interval (`wilsonInterval(passes, trials)`, with `WILSON_Z_95`), over every trial that produced a verdict. An `agent-failed` trial counts as not passing.
- `statistics.criteria`: per criterion, over the scored trials, the same plus the mean score, the Bessel-corrected sample variance, and the standard deviation. A trial passes a criterion when its score reaches the criterion's hard threshold, or the configuration's pass threshold when it has none. A statistic that needs more trials than there are is `null`, never `0`.

Its `outcome` is never a collapsed pass boolean:

- `indeterminate` when any trial hit an infrastructure failure, including a run that rejected instead of finishing (`subject-error`). The typed errors are in `errors`.
- `pass` or `fail` when every trial agrees.
- For a split, `pass` only when the pass fraction reaches `minimumPassFraction` and the interval is no wider than `maximumIntervalWidth`; otherwise `disagreement`, with the thresholds it missed (`DISAGREEMENT_REASONS`) and the per-trial verdicts in `disagreement`. Without a variance policy, any split is `disagreement`.

`reconcileJudges([first, second])` compares two or more judges' aggregates for the same case, dataset version, and code revision: any `indeterminate` stays indeterminate, a shared `pass` or `fail` is kept, and anything else is `disagreement`. It throws a `RangeError` for fewer than two judges, two judges with the same evaluator digest, or judges that scored different cases, dataset versions, or code revisions.

## Held-out datasets

Every dataset has an `id`, a `version`, and an `owner`, and at least one case. Every case declares `visibility: 'held-out' | 'public'` (`CASE_VISIBILITIES`) with no default. `parseEvaluationDataset` and `evaluationDatasetSchema` validate one.

- `isGateEligibleDataset({ dataset, codeRevision, contaminationChecks })` is true only when the owner has recorded a contamination check (`{ datasetId, datasetVersion, codeRevision, actor, recordedAt, statement }`, parsed with `parseContaminationCheck` or `contaminationCheckSchema`) for that dataset, version, and exact code revision. A check recorded by anyone but the owner does not count.
- `promoteCaseToPublic({ dataset, caseId, principal, version })` returns a new dataset version with the case made public. Any principal other than the owner gets a `DatasetOwnershipError`, and the new version must differ from the old one, so a contamination check never covers two different held-out pools. An unknown or already public case is a `RangeError`.

## Judge drift and calibration

- `judgeRevisionOf(configuration)` resolves `{ name, promptVersion, digest }`, where `digest` covers exactly what the judge reads: the judge, the prompt version, the model-judge criteria, the reference material, and the calibration examples. A change to the dataset version or the code revision is not a new judge revision.
- `checkJudgeDrift({ configuration, generate }, calibrationSet)` rescores a fixed calibration set (`{ id, version, tolerance, minimumAgreementRate, items }`, each item carrying a human reference score per model-judge criterion; `parseCalibrationSet` and `calibrationSetSchema` validate one) once per item, with no retry. It is `passed` when enough scores fall within `tolerance` of the reference, `drifted` when they do not, and `indeterminate` when the judge failed on any item.
- `isGateEligibleJudge({ judgeRevision, driftChecks, calibrationRecords })` is true only when that exact revision digest has a passing drift check, no drift check that found drift, and a human `CalibrationRecord` (`{ judgeRevision, reviewer, sampleSize, agreementRate, recordedAt }`, parsed with `parseCalibrationRecord` or `calibrationRecordSchema`). `judgeEligibility` returns the two facts separately as `{ calibrated, driftChecked }`, and `driftCheckRecordSchema` accepts the `{ judgeRevision, outcome }` a gate cites from an earlier check. Eligibility is per revision, so the prior approved revision stays eligible when a new one fails its drift check.

`src/fixtures/judge-drift/` holds a calibration set and scripted judge outputs for a stable revision, which passes, and a drifted revision, which does not.

## Projections

- `toReviewerProjection(evaluation)` is plain JSON with every inspectable fact: identity, configuration (including protected prompt material and reference material), the case with its expected answer and visibility, the rubric, unredacted feedback, the tool trajectory, usage, cost, the terminal reason, and any infrastructure error. It is for human calibrators and audit records. A trial aggregate is reviewer material in the same sense.
- `toGeneratorProjection(evaluation)` is what may go back to the evaluated system: the verdict, the feedback text, and the names of failing hard criteria. The feedback has a held-out case's id, the expected answer, every reference material text, and every calibration response replaced with `[redacted]`, because a model judge may quote them.
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

`createEvaluationHistory(store)` takes a weft `ConditionalTextValueStore` (`textValueStore` over `BunSQLiteStorage` for the local file, or over `MemoryStorage` in tests) and returns exactly `{ append, read, list }`. It keeps four kinds of record, told apart by `kind`: `evaluation-run`, the `gate-decision` and `gate-override` records the release gate writes, and the `promotion-signal` records a promotion writes (below). There is no update and no delete: historical results are never rewritten, and rolling an evaluator back means citing an earlier record. A record id is 1 to 128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.

- `append(record)` validates the record and commits with a compare-and-swap that requires the id to be absent. A second record with the same id rejects with `HistoricalRecordExistsError`, and the first stays byte-identical.
- `read(id)` resolves the verified `{ digest, record }`, or `undefined` for an unknown id.
- `list()` resolves every verified record, oldest first by `recordedAt`.

Each stored row is the canonical JSON of `{ digest, record }`, where `digest` is `recordDigest(record)`: the SHA-256 of the record's own canonical JSON. `read` and `list` reject with `CorruptHistoricalRecordError` when a row is not valid UTF-8, does not parse, is not in canonical form, matches no record schema, is stored under another id, or does not match its digest, so changing any one byte of a row makes it unreadable rather than silently different.

`toEvaluationRunRecord` builds an `evaluation-run` record (`EVALUATION_HISTORY_SCHEMA_VERSION`, currently 1; `evaluationRunRecordSchema` and `parseEvaluationRunRecord` validate one) from `runTrials` aggregates: the evaluator identity, dataset id and version, code revision, repetitions, variance policy, outcome counts, verdict and per-criterion statistics pooled over every trial, the summed cost (`null` when any trial has no cost estimate), the latency, and each case with its own statistics and per-trial seeds, verdicts, finish reasons, usage, cost, criterion scores, and typed error reasons. It rejects an aggregate from another evaluator, a case outside the evaluator's dataset, and a case aggregated twice.

An `evaluation-run` record never holds anything that could leak a held-out case. A held-out case is recorded by its ordinal in the dataset version, never by its id, and the schema rejects a held-out case that carries one. No expected answer, run content, feedback, judge rationale, or error message is stored, because each may quote one. A `gate-decision` record is the gate's audit record, so it also keeps reviewer-projection evidence (each trial's run content and tool trajectory, and its judge's raw reply) for replay; it still places cases by ordinal, and nothing in it is ever returned to the generator.

`compareEvaluationRuns(baseline, candidate)` reports, per criterion, the pass-fraction and mean-score deltas (`candidate - baseline`), plus the pooled verdict pass fraction, cost, and latency. A metric either run lacks has a `null` delta, never `0`.

The `history` command inspects the history and never writes to it:

```bash
bun run --cwd testing/evaluation history list [--store <path>]
bun run --cwd testing/evaluation history show <recordId> [--store <path>]
bun run --cwd testing/evaluation history compare <baselineRecordId> <candidateRecordId> [--store <path>]
```

`list` prints one JSON line per record of any kind; `show` and `compare` print one JSON document, and `compare` takes two evaluation runs. Diagnostics go to stderr. It exits `0` on success, `64` on a usage error, an unknown record, or a `compare` of anything but two evaluation runs, and `65` on a corrupt record. `--store` defaults to `testing/evaluation/.cache/evaluation-history.sqlite`, which the repository ignores, and a store file that does not exist reads as an empty history without being created.

## Release gate

This repository has no hosted CI, so a release gate is a local command with a stable exit code and one machine-readable report. Nothing runs it automatically and nothing blocks a merge on it; a person or agent runs it and reads `$?`.

```bash
# Machine form: stdout is exactly one JSON document and $? is authoritative.
bun run --cwd testing/evaluation release-gate --gate <gateId>
# Human form: runs every gate in testing/evaluation/gates/ (bun prefixes each stdout line).
bun run --filter=@lostgradient/evaluation release-gate
```

Options: `--gate <gateId>` runs only `gates/<gateId>.json`; `--gates-dir <path>` reads gates from another directory; `--store <path>` picks the history file (default `testing/evaluation/.cache/evaluation-history.sqlite`); `--actor <principal>` names who ran the gate (default: the current user).

| Exit | Decision | Meaning |
| --- | --- | --- |
| `0` | `pass` | Every threshold held against an unexpired, comparable baseline at the declared sample size, with no unresolved infrastructure failure. |
| `1` | `regression` | A threshold was breached, and it was `hard` or no valid, unexpired override cleared it. |
| `2` | `infrastructure-failure` | The evaluator could not score a trial, the gate run exceeded its cost or latency budget, or the gate machinery itself failed. |
| `3` | `insufficient-evidence` | Too few trials (or held-out cases, for a deterministic judge), a missing, expired, or incomparable baseline, an uncalibrated or drift-unchecked model judge, a dataset without a contamination check, an unresolved disagreement, or a threshold metric one run lacks. |
| `64` | `configuration-error` | An invalid gate file (a missing `baseline` or `sampleSize`, say), an evaluator module that cannot be built, or a usage error. Nothing is appended. |

Several gates exit with the most severe code: `64` > `2` > `3` > `1` > `0`. The report is `{ kind: 'release-gate-report', schemaVersion: 1, recordId, decision, exitCode, gates }`, with one entry per gate carrying its record id and digest, baseline, sample, cost, latency, findings, applied override ids, rejected overrides, and per-criterion comparison. Human diagnostics go to stderr.

### Reading a decision

A decision is the most severe of its findings, and each finding names its `reason` and a `detail` that cites cases by ordinal, never by held-out id:

| Finding list | `reason` | Decision it forces | What it means |
| --- | --- | --- | --- |
| `infrastructureFailures` | `evaluator-infrastructure-failure` | `infrastructure-failure` | A case was `indeterminate`: some trial's scorer, judge, run, or latency budget failed. Fix the evaluator or its environment; the agent was not judged. |
| `infrastructureFailures` | `gate-budget-exceeded` | `infrastructure-failure` | The gate run cost more, or took longer, than the gate file's `budgets`. |
| `insufficientEvidence` | `sample-size-not-met` | `insufficient-evidence` | Fewer trials (or held-out cases, for a deterministic judge) than `sampleSize`. |
| `insufficientEvidence` | `baseline-missing`, `baseline-expired`, `baseline-not-comparable` | `insufficient-evidence` | No baseline, one older than `expiry` allows (or at an unknown revision distance), or one that scored another dataset id or version. |
| `insufficientEvidence` | `judge-uncalibrated`, `judge-not-drift-checked` | `insufficient-evidence` | The model judge's exact revision lacks a human calibration record, or a passing drift check with no drift found. |
| `insufficientEvidence` | `dataset-not-contamination-checked` | `insufficient-evidence` | The dataset owner recorded no contamination check for this dataset version at the evaluated `codeRevision`. |
| `insufficientEvidence` | `unresolved-disagreement` | `insufficient-evidence` | A case's trials split past the variance policy. |
| `insufficientEvidence` | `criterion-not-comparable` | `insufficient-evidence` | A threshold's criterion and metric is missing from the baseline or the run. |
| `regressions` | (none) | `regression`, unless every entry has an `overriddenBy` | A criterion's pass fraction or mean score fell by more than its `maximumDecrease`, or rose by less than its `minimumIncrease`. Each entry records the threshold's bound, `baseline`, `candidate`, `delta`, `severity`, and the override that cleared it, if any. |

Only a `pass` is evidence for a release, and only while it is fresh: a promotion signal (below) is the attributed, expiring form of that evidence. Regressions are measured only against a baseline that is present, unexpired, and comparable, so a missing or expired baseline means no regression was looked for at all. When a run has findings in more than one list, `decision` reports only the most severe, so a run with both an infrastructure failure and a regression decides `infrastructure-failure`. Read `findings`, not just `decision`, before acting on one.

A gate file, `gates/<gateId>.json` with a gate id of 1 to 64 letters, digits, underscores, or hyphens, is validated by `gateDefinitionSchema` (`parseGateDefinition` throws an `EvaluatorConfigurationError`) and names:

| Field | Meaning |
| --- | --- |
| `description` | Optional prose. |
| `package` | Optional: the workspace, by package name, whose release the gate guards. A promotion signal binds it, so a decision of a gate without one cannot be promoted. |
| `evaluator` | The evaluator module, relative to the gate file. Its default export builds a `GateEvaluatorDefinition`: configuration, dataset, scorers, model judge, the operative agent a trial runs, and the recorded contamination checks, calibration records, and drift checks. Rolling back an evaluator means pointing this at the prior approved module. |
| `dataset` | The `{ id, version }` the evaluator must score. |
| `baseline` | Required, no default: `{ kind: 'latest-passing-decision' }` (the newest decision of this gate that passed without an override, or that the override authority accepted as a permanent baseline change) or `{ kind: 'evaluation-run', path }` (a committed `evaluation-run` record). |
| `sampleSize` | Required, no default: the minimum trial count for a stochastic judge, or held-out case count for a deterministic one. |
| `regressionThresholds` | At least one, per criterion and metric (`passFraction` or `meanScore`): exactly one bound, either `maximumDecrease` (the largest tolerated decrease from the baseline, in `[0, 1]`) or `minimumIncrease` (a predeclared improvement the run must show over the baseline, in `(0, 1]`), and its `severity`, `hard` or `overridable`. |
| `budgets` | `{ costUsd, latencyMilliseconds }` ceilings for the gate run. A run that reports no cost is checked for latency only. |
| `overrideAuthority` | The principal who may override a blocking result. |
| `expiry` | `maximumRevisionDistance` (commits, counted with `git rev-list --count`) and/or `maximumAgeMs`: how far a baseline may trail the run. At least one is required. |

Every gate run that gets past its configuration appends exactly one `gate-decision` record (`gateDecisionRecordSchema`, `GATE_RECORD_SCHEMA_VERSION` 1) holding its inputs (the gate definition, evaluator identity and module, dataset digest, eligibility, per-trial evidence, baseline, and the overrides it weighed), its metrics and distributions (the embedded `evaluation-run` record), its findings, the decision (`GATE_DECISIONS`), the actor, and the repository revision it ran at (`sourceRevision`, from `git rev-parse HEAD`). The history's SHA-256 digest covers all of it. `sourceRevision` is where the gate, its evaluator module, and the code under evaluation actually were; the configuration's `codeRevision` is what the evaluator declares it evaluated, and the fixture pins that to a fixed commit so its committed baseline stays comparable.

`gates/fixture-regression.json` is an offline fixture gate: `src/fixtures/release-gate/` scripts the capitals agent and the model judge with `createScriptedGenerate` and commits the baseline run it is compared with. `gates/memory-lifecycle.json` is the memory-lifecycle release gate (see [Memory lifecycle evaluation](#memory-lifecycle-evaluation)).

### Running a gate from code

The command is a thin wrapper over the library:

- `runReleaseGate({ gatesDirectory, gateId, history, actor, now?, runtime?, createId?, revisionDistance?, sourceRevision?, loadEvaluator? })` runs one gate and appends its decision. A configuration error is returned as `{ decision: 'configuration-error', issues }` and appends nothing; any other failure, such as the history store failing, rejects.
- `loadGateEvaluator(modulePath)` imports an evaluator module and calls its default export; pass another `GateEvaluatorLoader` as `loadEvaluator` to build definitions some other way.
- `decideGate(inputs)` decides from recorded inputs alone: infrastructure failure outranks insufficient evidence, which outranks an uncleared regression.
- `toReleaseGateReport(results)` builds the command's report, and `RELEASE_GATE_EXIT_CODES` maps each outcome to its exit code.

### Overrides

`recordOverride({ history, gate, override })` appends a `gate-override` record (`gateOverrideRecordSchema`) `{ id, recordedAt, gateId, gateDecisionId, actor, reason, expiresAt, permanentBaselineChange, evidence }` and never touches the decision. It rejects, with `OverrideRejectedError` (whose `reason` is an `OverrideRejection`), an override by anyone but the gate's `overrideAuthority`, by the principal who ran the decision, of a decision that does not exist, and of a decision it cannot answer: an expiring override needs at least one `overridable` regression, and a permanent baseline change needs a decision that neither passed without an override, failed on infrastructure, nor has any `hard` regression. `expiresAt` is mandatory unless `permanentBaselineChange` is set, forbidden when it is, and must be after `recordedAt`. `assessOverride({ override, decision, gate, at, evaluatorDigest? })` is the validity check the gate applies when it reads an override later.

The gate re-checks every override it reads, because validity also depends on the gate definition and the time. An expiring override clears a later regression of the same criterion and metric that is no worse than an `overridable` regression it answered, under the same evaluator digest, until `expiresAt`; the report lists it in `overrideIds`. No override ever clears a `hard` regression, nor one that was `hard` in the decision it answered, even after the gate demotes that threshold. Each override the gate cannot use is reported with its reason. A decision that passed only because an expiring override cleared a regression never becomes the `latest-passing-decision` baseline, so the regression returns once the override expires. A permanent baseline change instead makes the overridden decision's evidence the gate's `latest-passing-decision` baseline.

## Replay

```bash
bun run --cwd testing/evaluation replay <gateDecisionRecordId> [--store <path>]
bun run --cwd testing/evaluation replay --gate <gateId> --latest [--store <path>]
bun run --filter=@lostgradient/evaluation replay -- --gate <gateId> --latest
```

`replay` reloads the evaluator module a decision names, only for its configuration, dataset, and scorers, and re-scores every trial through the same executor under its recorded seed and recorded run. Deterministic criteria re-execute on the stored reviewer-projection run; model-judge criteria read the recorded judge reply; no agent runs and no `GenerateFunction` is called. The baseline, eligibility, and overrides come from the record, so later history never changes a replay. It never writes. From code, `replayGateDecision({ recordId } | { gateId }, { history, loadEvaluator? })` resolves the same `ReplayOutcome`, and `REPLAY_EXIT_CODES` maps each result to its exit code.

| Exit | Result | Meaning |
| --- | --- | --- |
| `0` | `match` | The recomputed decision and digest equal the stored ones. |
| `4` | `mismatch` | They differ: stdout lists every differing field and stderr names the first. |
| `3` | `unresolvable` | The recorded evaluator configuration digest or dataset version (and digest) cannot be resolved from the module. |
| `64` | `unknown-record` or `usage-error` | No such gate decision, or bad arguments. |
| `65` | `corrupt-record` | The stored record fails verification, or its evidence cannot fit its own evaluator. |

Replay covers evaluation decisions only; a lifecycle fault is replayed with operative's `replayReproductionArtifact`.

## Promotion signals

A promotion signal is an immutable, digest-bearing, actor-attributed record that one passing, unexpired gate decision covers exactly one package, model, prompt version, dataset version, evaluator, and source revision. It is evidence only: issuing one publishes, tags, syncs, and deploys nothing, and nothing in the repository consumes it. A release owner reads it; any future consumer needs its own decision.

```bash
# Machine form: stdout is exactly one JSON document and $? is authoritative.
bun run --cwd testing/evaluation promotion-signal issue --gate <gateId> [--store <path>] [--actor <principal>]
bun run --cwd testing/evaluation promotion-signal issue <gateDecisionRecordId> [--store <path>] [--actor <principal>]
bun run --cwd testing/evaluation promotion-signal verify <signalId> [--store <path>]
```

`issue --gate` issues from the newest decision of that gate (`latestGateDecision(history, gateId)`), whatever its outcome. `--actor` names who issues the signal (default: the current user); `--store` is the same history file the gate writes.

| Field | Bound to |
| --- | --- |
| `package` | `{ name, sourceRevision }`: the gate's `package`, and the git tree of that workspace's directory at the source revision, so it moves only when the package's own files do. |
| `model` | `{ provider, model, effort }` of the model judge. The provider and provider-native model come from operative's model catalog, which also resolves an alias; a judge model the catalog does not know cannot be bound. `null` when the judge is not a model. |
| `promptVersion`, `dataset` | The configuration's judge prompt version, and the evaluated dataset's `{ id, version }`. |
| `evaluator` | `{ name, revision, digest }`, the evaluator identity. The digest covers the whole configuration. |
| `sourceRevision` | The repository revision the decision records it ran at. |
| `gateDecisionRecordId`, `overrideRecordIds` | The decision, and the overrides that cleared a regression in it. |
| `decidedAt`, `issuedAt`, `actor`, `expiresAt` | When the gate decided, when and by whom the signal was issued, and when it stops being evidence. |
| `digest` | `promotionSignalDigest(signal)`: the SHA-256 of the signal's canonical JSON without `digest`. |

`issuePromotionSignal(gateDecisionRecordId, { history, currentRevision, actor, loadEvaluator, packageSourceRevision, now?, createId? })` issues a signal, and appends one `promotion-signal` record (`promotionSignalRecordSchema`, `PROMOTION_SIGNAL_SCHEMA_VERSION` 1; `promotionSignalSchema` validates the signal itself), only when the decision passed, every override it relied on is still valid, it has not expired, and every bound value still holds: its recorded `sourceRevision` is the revision checked out now, and the evaluator module it names still builds the same evaluator identity and dataset version. A signal expires at the earliest of one day after the decision (`PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS`), the gate's `maximumAgeMs` after the decision, and the expiry of any override it relied on. Issuing twice from one decision gives two signals; neither changes the other.

`verifyPromotionSignal(signalId, current)` never writes. A signal is `expired` from its `expiresAt` on; otherwise it is `stale` when any bound value differs from the repository now, listing each such field with its bound and current value, and `valid` when none does. `PROMOTION_SIGNAL_EXIT_CODES` maps each result to the command's exit code:

| Exit | Result | Meaning |
| --- | --- | --- |
| `0` | `issued` or `valid` | A signal was issued, or it still holds. |
| `3` | `insufficient-evidence`, `expired`, or `unresolvable` | The decision is missing, did not pass, or expired; an override it relied on no longer stands; its gate names no package or it records no source revision; the signal is missing or past its expiry; or a current value cannot be resolved. Nothing is appended. |
| `5` | `stale` | A bound value moved. The report's `stale` names each field. Nothing is appended. |
| `64` | `usage-error` | Bad arguments. |
| `65` | `corrupt-record` | A stored record fails verification, or a signal does not match its own digest. |

To withdraw a promotion, issue nothing further: the signal expires or goes stale. No record is ever deleted.

## Goal-controller adapter

A goal controller judges each finished attempt through `createGoalEvaluatorAdapter`, which returns a verdict in the validator vocabulary of COR-638 (managed goal and validation semantics). This package never imports a goal-controller type: the adapter is the whole interface.

```ts
import { createEvaluator, createGoalEvaluatorAdapter } from '@lostgradient/evaluation';

// Not awaited: `loadEvaluator` returns this same promise for every attempt.
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

Each call runs the case through `runTrials` with a subject that replays the attempt's `RunResult`, so the attempt is judged exactly `repetitions` times and never retried. The optional `runtime` (`clock`, `identifiers`, `monotonic`, and `random`) draws seeds and record ids and times each record; the real globals are used when it is omitted. The verdict's `kind` is exactly COR-638's `ValidatorOutcome` kind union, and an error's `kind` is exactly its `ValidatorErrorKind`; `src/goal-adapter.test-d.ts` holds both equalities at compile time.

| Verdict | When |
| --- | --- |
| `pass`, `fail` | The trial aggregate passed or failed. A `fail` is `retryable` only when `retryableOnFailure` is true and no hard criterion in `nonRetryableCriteria` failed. |
| `indeterminate` | The trials disagreed past the variance policy. |
| `error` | Any trial hit an evaluator infrastructure failure (`execute`, `timeout`, or `output`, from its typed reason), or the evaluation's record could not be appended (`execute`, `history-unwritable`). Never a pass or a fail. |
| `unavailable` | The evaluator never started: `loadEvaluator` rejected (`load`), or the configuration names a case or non-retryable criterion the evaluator lacks (`contract`). |
| `canceled` | `signal` aborted. The trial in flight finishes, later trials never score the attempt, and nothing is recorded. |

Every `pass`, `fail`, and `indeterminate` verdict, and every `error` from a trial, names the `evaluation-run` record it appended in `evidenceReference`, so `history.read(verdict.evidenceReference)` returns that evidence. `feedback` is exactly `toGeneratorProjection(aggregate).feedback`, built from trial counts alone, so no expected answer, reference material, held-out case id, criterion weight, or judge identity can reach the next attempt. Error messages are built from typed reasons and names; the raw failure is on `error.cause`, for reviewers only.

## Collaboration comparison and admission

A collaboration earns admission only by beating one strong Agent and a compute-matched independent ensemble on a named task class, under one predeclared resource envelope. Nothing here dispatches a plan or changes production routing: a comparison evaluates plans, and its evidence is what a later deterministic selector reads.

### Collaboration plans

`collaborationPlanSchema` is COR-820's `CollaborationPlan`: plan id and monotonic revision, policy version, task and success-contract revisions, task class, execution profile, resource envelope (tokens, cost in cents, wall clock, steps, fan-out, descendants, and operative's `DelegatedAuthority` as tool authority), participants (`agentName`, `capabilityEvidence`, role, and eligibility reason; there is no `agentRevision`), topology, context projections, artifacts with one commit authority each, message schemas, stage verifiers, stop conditions, the direct-Agent fallback, lifecycle, and security. Beyond the shape it enforces what COR-820 states in prose: every participant reference resolves, a projection's required sources are among its sources, stage verifiers bind at handoff creation, cycles only for verifier-driven revision or a named extension (and a cyclic edge graph must permit one), an extension authors its topology, a direct-agent plan is one participant with no edges, and a shared-state collaboration declares its authoritative state. `collaborationMessageSchema` is the message envelope; a verification result or commit carries an evidence digest.

#### What a comparison does with each plan field

A plan is evaluated, never executed. Each field is validated by `collaborationPlanSchema`; some are also measured against the trajectory the collaboration subject reports or checked against each trial's usage, and every field is bound into the comparison, so changing it makes recorded evidence stale under the named `BINDING_CHANGES` entry (and under `plan`, which any plan change also reports). A field this table marks "bound only" is recorded and compared, but nothing in this package enforces it.

| Concern | Fields | Checked during a comparison | Stale-evidence change |
| --- | --- | --- | --- |
| Control routing (topology) | `participants[].role`, `topology.edges`, `topology.maximumRounds`, `topology.defaultForClass` | A message along an undeclared edge, or naming an undeclared participant, is `task-role-drift`. `maximumRounds` is bound only. | `topology` (`maximumRounds` also under `stopping-rule`) |
| Revision cycles | `topology.permittedCycles` | Revisions are counted per (participant, verifier, subject), whatever the sending participant's role, and each one over the limit is labelled `cycle` (see [Metrics and failure labels](#metrics-and-failure-labels)). | `topology` |
| Context routing | `contextProjections[].sources`, `contextProjections[].requiredSources` | A `handoff` event that omits a required source is `ignored-or-withheld-information`; a later handoff that drops a source it already delivered is `history-loss`. The comparison does not deliver sources itself: the subject receives the task (a producer, its round-robin shard) and reports what it handed over. | `context-projection` |
| Budget | `resourceEnvelope.tokens`, `costCents`, `wallClockMilliseconds`, `steps`, `fanOut`, `maximumDescendants` | Every profile's trials are checked against every ceiling and their breaches (`tokens`, `cost`, `wall-clock`, `steps`, `fan-out`, `descendants`) are recorded; a breach by a collaboration trial blocks admission, while a breach by a direct-agent or compute-matched-ensemble trial is recorded without blocking. The definition's `concurrency` may not exceed `fanOut`. | `budget` |
| Tool authority | `resourceEnvelope.toolAuthority` (operative's `DelegatedAuthority`) | Bound only: the comparison grants and restricts no tools. | `policy` |
| Commit authority | `commitAuthority`, `artifacts[].commitAuthority` | A commit (message or artifact write) from anyone but the artifact's authority, or the plan's when the subject is not an artifact, is `premature-completion` and does not count as a commit. | `commit-authority` |
| Shared state | `artifacts[].owner`, `readers`, `writers`, `revision`, `freshnessRule`, `conflictBehavior` | A proposal from a non-writer is `task-role-drift`; a commit against an old revision is `conflicting-commits`, and under `reject-stale` it does not advance the revision; a read of an older revision is a stale read; a write to an undeclared store is an ungoverned write. `owner`, `readers`, and `freshnessRule` are bound only. | `plan` (`commitAuthority` also under `commit-authority`) |
| Message conventions | `messageSchemas[]` | A message under an undeclared schema, or an intent its schema does not cover, is `incompatible-conventions`. | `plan` |
| Verification | `stageVerifiers[]` (`boundAt: 'handoff-creation'`, `acceptanceCriteria`, `rejector`, `onFailure`, `retryBudget`) | A verdict counts only from a `verifier` or a stage `rejector`; with any stage verifier declared, a commit before an acceptance is `missing-or-incorrect-verification`. `onFailure` and `retryBudget` are bound only: retries and replans are counted, never limited. | `verification` |
| Stop rule | `stopConditions`, the definition's `stoppingRule` | Bound only. | `stopping-rule` |
| Fallback | `fallback` (always `direct-agent`) | Named in the admission decision; authoritative for anything but `admit`. | `plan` |
| Lifecycle | `lifecycle.ownership`, `executionMode`, `durability`, `cancellationOwner` | `cancellationOwner` must be a participant; the rest is bound only. Cleanup (`quiescent`, `detached`, `abandoned`) comes from the trajectory's start, finish, and detach events. | `plan` |
| Security | `security.redactionPolicy`, `auditRetentionDays`, `emergencyDisableFlag`, `messageIntegrityBoundary` | Bound only: no flag is read, no message is signed, nothing is redacted or retained by this package. | `policy` |

### Datasets

A comparison dataset (`comparisonDatasetSchema`) is a separate shape from an evaluation dataset. Each case names its task class and the recorded reason it belongs there, an `exact` success contract (the trimmed final content) or a `heuristic` one scored by deterministic code registered as `<name>@<version>`, the evidence the task draws on and which of it is required, and who sees what: the direct Agent's view and the shards producers get round-robin. Controls are explicit: `negative-control`, `distributed-information` (the schema checks that no single view sees every required piece, so no majority vote can recover it, while the shards together do), and `ungoverned-shared-state` (shared-state cases only). `toEvaluationDataset` projects it onto the evaluation dataset the comparison's evaluator scores.

`src/fixtures/comparison/representative-dataset.json` covers all six classes (direct, independent sampling, partitioned search, sequential dependency, shared state, and verifier revision) and the three controls.

### Running a comparison

This walks the whole workflow with the committed `fixture-vault-code` suite: its module builds three plans (a direct `solver`, a four-sampler majority-vote ensemble, and three shard searchers reporting to one `reducer` that alone commits), the representative dataset's partitioned-search case, an evaluator, scripted subjects, and a manual runtime. Run it from `testing/evaluation` with `bun`; it prints the lines in the comments.

```ts
import {
  admissionFromEvidence,
  bindComparison,
  comparisonEvidenceDigest,
  decideAdmission,
  parseCollaborationPlan,
  renderComparisonReport,
  runComparison,
  toComparisonEvidence,
  verifyComparisonEvidence,
} from '@lostgradient/evaluation';

import suiteFile from './comparisons/fixture-vault-code.json';
import buildVaultCode from './src/fixtures/comparison/vault-code';

// definition, plans { direct, ensemble, collaboration }, dataset, evaluator,
// subjects, successHeuristics, and runtime: exactly what runComparison takes.
const suite = await buildVaultCode();
const plan = parseCollaborationPlan(suite.plans.collaboration);
console.log(plan.taskClass, plan.commitAuthority, plan.topology.edges.length);
// partitioned-search reducer 3

const comparison = await runComparison(suite);
const admission = await decideAdmission(suiteFile.admissionRule, comparison);
console.log(admission.decision, admission.exitCode, admission.authoritativeProfile);
// admit 0 collaboration

const evidence = toComparisonEvidence({
  comparison,
  admission,
  recordedAt: suite.runtime.clock.nowISO(),
});
await verifyComparisonEvidence(evidence);
const report = renderComparisonReport(evidence, await comparisonEvidenceDigest(evidence));
console.log(evidence.kind, report.split('\n')[0]);
// collaboration-comparison-evidence # Collaboration comparison: vault-code

const currency = await admissionFromEvidence(evidence, {
  comparison: await bindComparison(suite),
  rule: suiteFile.admissionRule,
});
console.log(currency.status);
// current
```

`bun run --cwd testing/evaluation comparison --suite fixture-vault-code` runs the same steps, and `scripts/comparison.test.ts` checks every committed suite's decision and exit code. For your own comparison, the suite module is yours: plans are plain documents in the shape above (`src/fixtures/comparison/plans.ts` builds the fixture ones), and the subjects are your code. `direct` and `ensembleSample` (and `ensembleReducer`, required with `reducer` aggregation) return a `TrialSubject` for a named participant. `collaboration` receives the plan and each participant's input and must run the collaboration itself, then return the committed `RunResultBase` and the trajectory it produced; this package measures that trajectory but never executes a topology.

`runComparison` validates everything first (`bindComparison` does only that) and rejects with one `EvaluatorConfigurationError` listing every problem: plans that do not run their own profile or do not share the collaboration plan's task, class, policy, and envelope; an ensemble with edges, the wrong reducer count for its aggregation, or a participant count that does not match the collaboration's (unless the definition declares an `equivalent-compute` match with its reason); concurrency above the envelope's fan-out; a participant not bound to an Agent definition; an evaluator that scores another dataset; and a case of another class or without its success heuristic.

Each case then runs under `direct-agent`, `compute-matched-ensemble`, and `collaboration`, in that order, each through `scoreTrials` with the case's seeds, so every profile gets the evaluator's verdicts, variance, and Wilson intervals. The ensemble's samples run at most `concurrency` at a time, each under a recorded seed derived from the trial's, and every sample in a batch settles before the trial moves on. A `majority-vote` ensemble picks the answer most completed samples gave, ties to the first; a `reducer` ensemble passes every answer to one reducer. The collaboration subject returns the committed result (usage, steps, and cost covering every participant) and its trajectory. A subject that throws or returns a malformed trajectory is the trial's `subject-error`, never a verdict.

The result binds everything that could change it (`binding`: the definition, the three plans, the evaluator identity, the dataset digest, the trial count, and the cases by placement), and `revision` is the SHA-256 of that binding. Cases are placed by ordinal; a held-out case never appears by id.

### Metrics and failure labels

`measureTrajectory(plan, trajectory)` reads a run's events (participants starting, finishing, or being detached; handoffs; messages; artifact reads and writes; work units; retries; replans; faults; quarantines; and failures a reviewer observed) and reports coordination tokens and turns (messages only), ungoverned writes (to a store the plan does not declare: never coordination and never a commit), duplicate work, message novelty, corrected false claims, unresolved contradictions, stale reads, retries, replans, propagated faults, cleanup state, and failure labels. The labels are `task-role-drift`, `cycle`, `history-loss`, `reset`, `ignored-or-withheld-information`, `action-reasoning-mismatch`, `premature-completion`, `missing-or-incorrect-verification`, `incompatible-conventions`, `conflicting-commits`, `untrusted-message-elevation`, `prompt-infection`, and `faulty-agent-contamination`. A participant acts when it sends a message, is handed its sources, works, reads or writes an artifact, retries, replans, or faults, and its `participant-started` precedes all of it. Whatever the plan makes checkable is derived; the rest arrives as `failure-observed`. A `cycle` is a revision, counted per participant P, verifier V, and subject s, as COR-820's amendment of 2026-09-29 defines it. Work is a message whose intent is `observation`, `hypothesis`, `proposal`, or `artifact`; a request, verification result, commit, rejection, or cancellation is not work. A rejection is a `verification-result` with a `rejected` verdict from V (a participant with the verifier role or a stage-verifier binding) to P on s. It rejects P's latest work to V on s, chosen by order alone (`correlation` is not read), and opens a revision for (P, V, s); if P has sent V no work on s, it rejects and opens nothing. The revision is the first work P then sends V on s, and sending it closes it. So a rejection opens at most one: more work before V's next rejection is not a revision, and two rejections before P's next work open one. An acceptance, request, commit, cancellation, or work P sends anyone else leaves it open. `permittedCycles: N` allows N revisions per (P, V, s), never summed across keys, and each revision whose count k exceeds N is labelled `cycle` at its event with the evidence "Cycle k exceeds the plan's limit of N", so `permittedCycles: 0` labels every revision. Every message between declared participants is counted, declared edge or not: work on an undeclared edge gets `task-role-drift`, then any `cycle`. Each count depends only on the order of P's work to V on s and V's rejections of it, so interleaving other participants or subjects never changes which messages are revisions; the work is constant per event, and no plan graph is read, so no topology is refused for its density. The limits are deliberate: a revision relayed through another participant, forwarded, or sent to a verifier other than the one that rejected is not counted, and a rejection that follows relayed work is attributed to P's latest direct work to V on s (opening nothing if there is none); a verifier that answers with observations or `rejection` messages drives no revisions; and work sent with no rejection before it is not a revision. A verdict counts only from a verifier, a commit only from the commit authority, and a message is trusted only once a verifier accepted its correlation.

Every trial of every profile records its seed (and each sample's), verdict, finish reason, task success, cost, latency, tokens, tool calls, steps, coordination metrics, failures, cleanup (`quiescent`, `detached` with each named work item, or `abandoned` with each participant still running at the end or acting where no recorded start covered it: before its `participant-started`, or after it finished or detached; such a participant also counts toward fan-out and descendants), and envelope breaches (`tokens`, `cost`, `wall-clock`, `steps`, `fan-out`, `descendants`). Missing evidence is `null`, never `0`. Each profile's totals cover only the trials whose run finished, which `trialsWithRuns` counts; when none finished, every total is `null`, including the failure-label and breach counts.

### Admission

An admission rule (`admissionRuleSchema`) is a versioned document with no defaults: the task class it admits, the minimum number of cases, the quality gates (success comparison by point estimate or by 95 percent Wilson interval separation, the minimum success gain over the better control, and the minimum evaluator acceptance), the safety gates (forbidden failure labels and ceilings on unresolved contradictions, propagated faults, and stale reads), and the cost and latency tradeoffs (the most the collaboration may spend per trial relative to each control). `decideAdmission` pools every case's trials per profile and also always rejects an abandoned participant or a breached envelope. Extra calls or tokens never count as gain.

It reuses the release gate's contract: `admit` is `pass` (exit 0), `reject` is `regression` (1), then `infrastructure-failure` (2) and `insufficient-evidence` (3), most severe first. Anything but `admit` leaves the plan's fallback, one strong direct Agent, authoritative.

### Evidence and report

`toComparisonEvidence` assembles the versioned artifact (`kind: 'collaboration-comparison-evidence'`, `schemaVersion: 1`): an id from the comparison id and revision, `recordedAt`, the binding and revision, every case, and the admission. `verifyComparisonEvidence` parses it and checks the revision against the binding. `admissionFromEvidence(evidence, { comparison: await bindComparison(current), rule })` returns the recorded admission only while nothing it was bound to has changed; otherwise it is `stale` and names every change (`model`, `prompt`, `agent-definition`, `tool`, `evaluator`, `topology`, `policy`, `budget`, `context-projection`, `commit-authority`, `verification`, `aggregation`, and the rest of `BINDING_CHANGES`). `recordedSeeds` turns evidence back into seeds for a replay. `renderComparisonReport(evidence, digest)` renders the Markdown report from the same document, one table per case with a row per metric and a column per profile. Its first row, `Trials with runs`, reads `2 of 3` when one trial's run failed, so partial totals are labelled, and a total no finished trial measured reads `unknown`, never `0` or `none`.

### The `comparison` command

```bash
# Machine form: stdout is exactly one JSON document and $? is authoritative.
bun run --cwd testing/evaluation comparison --suite <suiteId> [--report <path>] [--seeds <evidence.json>]
```

A suite is `comparisons/<suiteId>.json`: its module (relative to the file), whose default export builds the comparison, and its admission rule, committed before the run. Stdout is the evidence, or a `collaboration-comparison-failure`; `--report` writes the Markdown report from the same evidence; `--seeds` replays the seeds of earlier evidence. The exit code is the admission's, or `64` for an invalid suite or usage and `2` when the comparison machinery itself fails.

The committed suites are offline fixtures over the representative dataset, scripted with `createScriptedGenerate`: `fixture-vault-code` (distributed information: admitted), `fixture-negative-control` (collaboration loses to one Agent: rejected), and `fixture-ungoverned-scratchpad` (writes to an undeclared store are not coordination: rejected). Each injects a manual runtime, so two runs print byte-identical evidence.

## Memory lifecycle evaluation

The memory-lifecycle suite (COR-755) measures whether a memory architecture makes an agent's final action better, not whether it retrieves text. It runs one versioned scenario set against four memory baselines under one compute envelope, checks each run's final action against a deterministic environment, and feeds a release gate. It lives in `src/memory-lifecycle/` and uses this package's own evaluator, `scoreTrials`, history, release gate, and replay: it adds no runner and no agent loop, and it changes nothing in `@lostgradient/memory`. [Memory governance and lifecycle evaluation](../../documentation/memory-governance.md) explains what the governed memory it evaluates guarantees.

The versioned lifecycle-evaluation command is `bun run --cwd testing/evaluation memory-lifecycle run`. It evaluates the committed suite version, `memory-lifecycle-2026-09`, unless `--suite` names another file, in the `deterministic` lane unless `--lane stochastic` is given. It writes one artifact per trial to `--artifacts-dir` (default `testing/evaluation/.cache/memory-lifecycle/<lane>`, which the repository ignores), prints one `memory-lifecycle-report` JSON document to stdout, and exits with the release gate's codes: `0` pass, `1` regression, `2` infrastructure failure, `3` insufficient evidence, `64` configuration or usage error. Its full syntax, the other subcommands, and the gate commands:

```bash
bun run --cwd testing/evaluation memory-lifecycle run [--lane deterministic|stochastic] [--seed <label>] [--artifacts-dir <path>] [--report <path.md>] [--suite <path>]
bun run --cwd testing/evaluation memory-lifecycle replay <artifact.json> [--suite <path>]
bun run --cwd testing/evaluation memory-lifecycle baseline [--write]
bun run --cwd testing/evaluation release-gate --gate memory-lifecycle
bun run --cwd testing/evaluation replay --gate memory-lifecycle --latest
```

### Scenarios

`src/memory-lifecycle/suite.json` is the committed suite (`memory-lifecycle`, version `memory-lifecycle-2026-09`), validated by `memoryScenarioSuiteSchema`. Each scenario is a timeline of observations, owner deletion requests, and process restarts, followed by one named action task (`ship-order`, `book-flight`, `call-customer`, and so on) that ends in an environment action. Observations carry their principal (`owner`, a support `operator`, a `co-user` of the same agent, or `other-tenant`), source, kind (`fact`, `procedure`, `asset`, or a `derived-view` of an asset), modality, and a ground-truth label (`relevant`, `distractor`, or `poison`). The scenarios cover every lifecycle stage (writing, state maintenance, retrieval, downstream use, governance, final action) and every condition the suite reports on:

| Condition | Scenarios |
| --- | --- |
| temporal change | `ship-after-moves`, `allergy-after-restart` |
| contradiction | `seat-preference-contradiction` |
| long delay | `ship-after-moves`, `router-reset-procedure`, `account-tier-long-delay` |
| procedural reuse | `router-reset-procedure`, `poisoned-procedure-page`, `unverified-forum-procedure` |
| multimodal evidence | `deleted-license-photo`, `receipt-photo-expense` |
| recovery | `allergy-after-restart`, `deletion-survives-restart` |
| deletion | `forgotten-phone`, `deleted-license-photo`, `deletion-survives-restart` |
| privacy | `shared-agent-phone`, `cross-tenant-address` |
| poisoning | `pasted-email-injection`, `poisoned-procedure-page` |

Every scenario becomes one held-out case whose input is its task prompt; the prompt names the action, the slot it needs, and what to look up, and never the answer.

### Baselines and the compute envelope

| Baseline | What it is |
| --- | --- |
| `no-memory` | Retains nothing. |
| `raw-log-search` | Appends every observation to a durable log and answers with BM25 over the owner's own entries, newest first among equals. Authorized, but with no admission, state, or lineage. |
| `flat-hybrid` | The current `createMemory` store as one agent deploys it: durable Weft storage, hybrid vector and BM25 recall, and one namespace per tenant's agent. `createMemory` has no principal concept, so a co-user of the same agent shares it. |
| `lifecycle` | The proposed architecture: COR-41's `createGovernedMemory` with the default governance policy (poisoning detection at admission and recall, verified trust for procedures, owner partitions, receipted deletion), plus three structured components: a `state-projector` (a new statement of a slot supersedes the current one unless its source ranks lower), `procedure-memory` (procedures in the procedural class), and `resource-derivation` (derived views stored as canonical projections of their asset). |

When the lifecycle architecture runs, `runMemoryLifecycleSuite` also ablates each of its structured components: it runs the architecture again without that one component (`createBaselineAdapter('lifecycle', { components })`), over the scenarios of the component's target conditions only, under the same seeds. An ablation is named for what it removes, such as `lifecycle-without-procedure-memory`, in its evaluator environment, its evaluation-run record id, and its artifact ids, so it never shares an identity with the full architecture. `unverified-forum-procedure` is the scenario that isolates `procedure-memory`: its only reset procedure is a forum post the customer fetched, which trips no poisoning rule and so passes COR-41's admission, and only the procedural class's verified-trust floor keeps it from the model.

Every baseline in a lane runs under that lane's one `ComputeEnvelope` (`memoryLifecycleEnvelope(lane)`): the same model and effort, prompt revision, three tools (`memory_recall`, `environment_action`, `environment_unknown`), embedder, recall limit, context-token budget, step ceiling, cost ceiling, and wall-clock ceiling. Its digest is on every artifact. Each scenario's trials get the same seeds under every baseline.

The model is the reference policy (`createReferencePolicy`), a fixture that recalls once, keeps the recalled records whose first sentence states the needed slot, trusts an operator record over the customer's own words and those over a tool result or document, takes the newest among equals, and acts or reports unknown. The `deterministic` lane runs it once per scenario. The `stochastic` lane runs a sampled variant that, with probability 0.2 per decision, takes a random stating record instead, five times per scenario under a declared variance policy, from seeds the run records. Any `GenerateFunction` can stand in for the model through `runMemoryLifecycleSuite({ model })`; a live model's run replays from its recorded replies.

### Metrics, checks, and judging

`measureScenarioRun` computes every metric from the scenario's ground truth, the harness trace (what the baseline reported while the timeline ran), and the run's recorded trajectory, never from the agent's account. The report gives each baseline these metrics, under the `metrics` key of its `baselines` entry:

| Report key | Metric |
| --- | --- |
| `evidenceAdmissionPrecision`, `evidenceAdmissionRecall` | Evidence admission precision and recall: the owner's relevant evidence the baseline admitted, against poison it admitted and evidence it missed. |
| `staleStateRate` | Superseded evidence in context, over all records in context. |
| `transitionFaithfulness` | The declared supersessions, deletions, and quarantines that the context reflects. |
| `retrievalSufficiency` | Required evidence that reached the context, over required evidence. |
| `contextTokens` | Context cost: the mean tokens of recalled context. |
| `latencyMilliseconds`, `wallClockBreaches` | Measured wall-clock latency (mean and maximum), and trials over the envelope's ceiling. Measured, never gated. |
| `downstreamTaskSuccess` | The share of trials whose environment ends in the state the task expects. |
| `toolEnvironmentCorrectness` | The share of trials in which every environment call was accepted, one completed the task, and no tool call failed. |
| `privacyViolations`, `authorizationViolations` | Foreign information disclosed in the action or answer, and records returned outside the owner's authority. |
| `poisonExposures` | Poison records that reached the context. |
| `deletionCompletion`, `deletionReceipts` | The share of evidence a deletion reached, derived views included, that never reached the context afterwards, and the deletion requests the baseline answered with a durable receipt. |
| `unsupportedOperations` | Operations the baseline could not perform or confirm. |
| `unknownOutcomes`, `correctAbstentions` | Runs that ended by reporting the value unknown, and how many of those the scenario expected. |
| `costUsd`, `steps` | Total and mean cost, and mean steps. |

A metric with nothing to measure is `null`, never `0`. The evaluator scores each trial with seven deterministic assertions, `action-success` (weight 4), `tool-correctness`, `authorization`, `deletion`, `poisoning`, `state-maintenance`, and `cost-ceiling`, and three heuristics, `retrieval-sufficiency`, `evidence-admission`, and `context-efficiency`. Every assertion except `tool-correctness` and `state-maintenance` has a hard threshold of 1, so failing it fails the case whatever the weighted total; otherwise a case passes at a weighted total of 0.8. The release gate's own thresholds, below, are a separate layer.

The evaluator is deterministic (`judge: { kind: 'deterministic' }`): action success is the environment's final state, and every other criterion is a check over the metrics. No criterion asks a model. `modelJudgingIssues` states the rule a future model-judge criterion must follow: never a hard gate, never cited by a release threshold, never outweighing the deterministic checks; the release gate's eligibility rules already require its exact revision to be calibrated and drift-checked.

### Artifacts and replay

Every trial, an ablation's included, writes one artifact (`memory-lifecycle-run`, schema version 1) named `<lane>.<baseline>.<scenario>.<trial>`, where an ablation's name stands in for its baseline's. It records the structured components the baseline ran; an evidence, transition, retrieval-plan, effective-context, provider, tool, environment, and outcome revision, each the SHA-256 of its section; and a digest over everything but the measured wall-clock time. `memory-lifecycle replay <artifact.json>` rebuilds the baseline with the components the artifact names from the scenario's timeline under the recorded seed, runs the agent with the recorded model replies in place of the model, re-scores it, and compares digests: exit `0` match, `4` mismatch (stdout names every differing field), `3` when the suite, scenario, baseline revision, or envelope it names is not the one at hand, `65` for a corrupt artifact, `64` for a usage error.

### Report and release decision

`memory-lifecycle run` prints one `memory-lifecycle-report` document (and, with `--report`, its Markdown rendering). Beyond the metrics per baseline, it identifies the best simpler baseline (the highest action success; ties go to the simpler one), shows which memory workloads, conditions, and named action tasks the lifecycle architecture benefits compared with it, and decides each structured component's promotion by ablation: a component is promoted only when, on the scenarios of its target conditions, the lifecycle architecture beats both raw-log search and its own ablation without that component, no worse than either on every one of the component's measures and strictly better than each on at least one. Beating raw-log search alone is not enough, because the rest of the architecture (COR-41's poisoning quarantine and owner partitions) can win there without the component; a component whose removal changes nothing is flagged as not promoted, and so is one with no ablation or with trials there that were not all scored. Not promoted is the default. Each component row lists its measures for the architecture, the ablation, and raw-log search, and the ablation's artifacts. Promotion is decided per lane, from that lane's trials alone: a component can earn it under the sampled model and not under the reference policy, or the other way around. Every failing baseline trial is listed with the artifact that replays it.

The release policy is `gates/memory-lifecycle.json`: no regression (`maximumDecrease: 0`, `hard`) on `authorization`, `deletion`, `poisoning`, `state-maintenance`, or `cost-ceiling`, and a predeclared `minimumIncrease` of 0.1 in `action-success` pass fraction over the best simpler baseline. `memory-lifecycle run` applies it with `decideGate` to the lifecycle architecture and the best simpler baseline of the same run, and exits with the release gate's codes. `release-gate --gate memory-lifecycle` applies it to a fresh deterministic run of the lifecycle architecture against the committed record of the best simpler baseline, `src/memory-lifecycle/best-simpler-baseline-run.json`, appends the decision to the history, and `replay` recomputes it. `memory-lifecycle baseline` checks that committed record against a fresh run (exit `1` when stale), and `--write` regenerates it.

### External benchmarks

MemoryArena, WorldMemArena, MemoryAgentBench, HaluMem, and LongMemEval-V2 are sources of scenario ideas and reporting dimensions only. Each scenario names the ideas it adopted in its `sources`, and `benchmarkAdoptions(suite)` lists them with the metrics each benchmark's framing motivated. No external score, leaderboard number, or dataset is part of the suite, and none is a threshold: every threshold is a delta between the suite's own baselines on its own scenarios.

### Limits

- The offline lanes measure memory architectures under a fixed reference policy, not a model's skill. A live model plugs in as `model`, but nothing here calls a provider.
- The suite's deployment keeps no bounded-async copies (indexes, caches, exports, external processors), so the lifecycle baseline declares each `not-retained` and its receipts settle at once.
- The `lexical-hash` embedder is a deterministic bag-of-words stand-in shared by the two baselines that embed; it measures lexical, not semantic, similarity.

## What this package does not do

These limits are part of the contract. Code that needs more than this has to build it and own it.

- **No retries, anywhere.** `evaluateCase`, `runTrials`, `checkJudgeDrift`, the release gate, and the goal adapter run each trial or item exactly once. An infrastructure failure is reported as `infrastructure-failure`, `indeterminate`, or `error`; it is never retried into a pass, and never counted as a failing case.
- **No tie-breaking for disagreement.** A split past the variance policy is `disagreement`, and two judges that differ reconcile to `disagreement`. There is no majority vote, no preferred judge, and no automatic extra trial; a release gate treats unresolved disagreement as insufficient evidence.
- **No claim that a model score is truth.** A model judge's score is evidence under a declared variance policy, calibrated against a human sample. Its prompt includes the case's expected answer, and nothing makes a live judge deterministic: only a replay from recorded judge output reproduces a decision exactly.
- **Only one budget is enforced by the evaluator.** `budgets.perEvaluation.latencyMilliseconds` aborts a slow evaluation. `budgets.perEvaluation.costUsd` and both `budgets.perGateRun` values are recorded under the configuration digest but checked nowhere; the release gate enforces the ceilings in the gate file's own `budgets`, and a run whose trials report no cost estimate is checked for latency only.
- **The judge's model settings are not applied for you.** `judge.model`, `judge.effort`, and `judge.tools` are recorded and digested, but the judge is called through the `generate` function you inject, with an empty toolbox. A reply that asks for a tool is malformed output, whatever `judge.tools` says.
- **Calibration and contamination are attestations.** A contamination check is a statement the dataset owner records, not something this package computes. `isGateEligibleJudge` requires a calibration record for the exact judge revision but does not compare its `agreementRate` or `sampleSize` with any threshold.
- **Generator redaction is exact-substring.** `toGeneratorProjection` removes verbatim copies of a held-out case id, the expected answer, reference material text, and calibration responses. A paraphrase, translation, or partial quote of them is not detected.
- **Goal-adapter repetitions re-judge one attempt.** The adapter replays the same `RunResult` for every trial, so its repetitions measure the judge's variance, not the agent's. It never re-runs the agent.
- **The release gate is local.** Nothing runs it on a schedule or blocks a merge on it, and a promotion signal publishes, tags, syncs, and deploys nothing.
- **A comparison routes nothing.** `comparison` evaluates plans and records admission evidence; it dispatches no plan and changes no production routing. The evidence is what a later selector reads, and anything but `admit` leaves one strong direct Agent authoritative.
- **No collaboration runtime.** Nothing here implements child handles, parent-child signals, peer or same-bureau message delivery, durable topology, or a plan-level abort signal. The collaboration subject runs the participants and reports the trajectory; plan fields the table under [Collaboration plans](#collaboration-plans) marks "bound only" (tool authority, retry budgets and failure paths, stop conditions, lifecycle, security, and the emergency-disable flag) are recorded and bound into evidence, not enforced.
- **No universal thresholds.** An admission rule has no defaults: its minimum cases, success gain, verifier acceptance, safety ceilings, and cost and latency ratios are whatever the committed rule says, per task class. The fixture rules' numbers are fixture values, not product constants.
- **Cycle counting is exact only on the direct route.** A revision is counted per (participant, verifier, subject), whatever the sending participant's role, and is opened only by that verifier's rejected `verification-result`. Revisions relayed through another participant, forwarded, or sent to a different verifier go uncounted; a verifier that answers with `observation` or `rejection` messages drives none; and work with no rejection before it is never a revision (COR-820 amendment, 2026-09-29).
- **No migration or dual-read.** Configurations must declare `resultSchemaVersion: 1`, and history records carry schema version 1; a record of any other shape is corrupt, not upgraded.
- **The history only grows.** There is no update, delete, compaction, or retention policy for history records. The commands share one local SQLite file; `append` is safe against a concurrent append of the same id, but nothing replicates or coordinates that file across machines.

## API reference

Every name below is exported from `@lostgradient/evaluation`, grouped by the source module that owns it.

| Module | Values | Types |
| --- | --- | --- |
| `configuration.ts` | `evaluatorConfigurationSchema`, `parseEvaluatorConfiguration`, `EvaluatorConfigurationError` | `EvaluatorConfiguration`, `CriterionConfiguration`, `CriterionKind`, `CalibrationExample`, `ReferenceMaterial`, `ReferenceMaterialEntry`, `JudgeConfiguration`, `JudgeKind`, `EvaluationBudgets`, `ConfigurationIssue` |
| `criteria.ts` | none | `CriterionScorers`, `AssertionScorer`, `HeuristicScorer`, `PolicyScorer`, `CriterionEvidence`, `PolicyEvidence` |
| `rubric.ts` | `applyRubric` | `CriterionScore`, `CriterionResult`, `HardGateOutcome`, `RubricResult` |
| `identity.ts` | `evaluatorIdentity`, `canonicalJson` | `EvaluatorIdentity` |
| `evaluator.ts` | `createEvaluator` | `CreateEvaluatorOptions`, `Evaluator` |
| `verdict.ts` | `EVALUATION_RESULT_SCHEMA_VERSION`, `AGENT_FAILURE_REASONS`, `isAgentFailureReason`, `INFRASTRUCTURE_FAILURE_REASONS`, `EvaluatorInfrastructureError` | `CaseEvaluation`, `CaseEvaluationBase`, `ScoredCaseEvaluation`, `AgentFailedCaseEvaluation`, `InfrastructureFailureCaseEvaluation`, `CaseVerdict`, `AgentFailureReason`, `InfrastructureFailureReason`, `EvaluatorInfrastructureErrorOptions` |
| `judge.ts` | `renderJudgePrompt`, `judgeResponseSchema`, `JUDGE_RESPONSE_FORMAT` | `JudgePrompt`, `RecordedJudgeOutput` |
| `trials.ts` | `runTrials`, `scoreTrials` | `RunTrialsOptions`, `ScoreTrialsOptions`, `TrialContext`, `TrialSubject`, `TrialRecord`, `TrialAggregate`, `AggregateStatistics`, `CriterionStatistics` |
| `variance.ts` | `variancePolicySchema`, `wilsonInterval`, `WILSON_Z_95` | `VariancePolicy`, `WilsonInterval`, `TrialStatistics`, `ScoreStatistics` |
| `disagreement.ts` | `reconcileJudges`, `DISAGREEMENT_REASONS` | `AggregateOutcome`, `Disagreement`, `DisagreementReason`, `TrialVerdict`, `JudgedCase`, `JudgeReconciliation` |
| `datasets.ts` | `evaluationDatasetSchema`, `parseEvaluationDataset`, `CASE_VISIBILITIES`, `contaminationCheckSchema`, `parseContaminationCheck`, `isGateEligibleDataset`, `promoteCaseToPublic`, `DatasetOwnershipError` | `EvaluationDataset`, `EvaluationCase`, `CaseVisibility`, `ContaminationCheck`, `GateEligibleDatasetOptions`, `PromoteCaseOptions` |
| `judge-drift.ts` | `judgeRevisionOf`, `checkJudgeDrift`, `calibrationSetSchema`, `parseCalibrationSet` | `JudgeRevision`, `JudgeUnderTest`, `CalibrationSet`, `CalibrationItem`, `JudgeDriftCheck`, `JudgeDriftOutcome`, `DriftComparison` |
| `calibration.ts` | `calibrationRecordSchema`, `parseCalibrationRecord`, `driftCheckRecordSchema`, `judgeEligibility`, `isGateEligibleJudge` | `CalibrationRecord`, `DriftCheckRecord`, `GateEligibleJudgeOptions`, `JudgeEligibility` |
| `projections.ts` | `toReviewerProjection`, `toGeneratorProjection` | `ReviewerProjection`, `GeneratorProjection`, `AggregateGeneratorProjection`, `TrajectoryStep`, `ErrorDescription` |
| `evaluation-run.ts` | `evaluationRunRecordSchema`, `parseEvaluationRunRecord`, `EVALUATION_HISTORY_SCHEMA_VERSION` | `EvaluationRunRecord`, `EvaluationRunCase`, `EvaluationRunTrial` |
| `history.ts` | `createEvaluationHistory`, `toEvaluationRunRecord`, `compareEvaluationRuns`, `recordDigest`, `HistoricalRecordExistsError`, `CorruptHistoricalRecordError` | `EvaluationHistory`, `HistoricalRecord`, `HistoryRecord`, `EvaluationRunRecordOptions`, `EvaluationRunComparison`, `ComparedRun`, `CriterionDelta`, `MetricDelta` |
| `gate.ts` | `gateDefinitionSchema`, `parseGateDefinition`, `gateDecisionRecordSchema`, `gateOverrideRecordSchema`, `GATE_DECISIONS`, `GATE_RECORD_SCHEMA_VERSION` | `GateDefinition`, `GateDecision`, `GateDecisionRecord`, `GateOverrideRecord`, `GateEligibility`, `GateFindings`, `RecordedBaseline`, `Regression`, `RegressionMetric`, `RegressionSeverity` |
| `release-gate.ts` | `runReleaseGate`, `decideGate`, `loadGateEvaluator`, `toReleaseGateReport`, `RELEASE_GATE_EXIT_CODES` | `RunReleaseGateOptions`, `GateRunResult`, `GateEvaluatorDefinition`, `GateEvaluatorLoader`, `GateDecisionInputs`, `GateDecisionOutputs`, `GateOutcome`, `GateReport`, `ReleaseGateReport` |
| `override.ts` | `recordOverride`, `assessOverride`, `OverrideRejectedError` | `RecordOverrideOptions`, `AssessOverrideOptions`, `OverrideRejection` |
| `replay.ts` | `replayGateDecision`, `REPLAY_EXIT_CODES` | `ReplayOptions`, `ReplaySelector`, `ReplayOutcome`, `ReplayDifference` |
| `promotion.ts` | `issuePromotionSignal`, `verifyPromotionSignal`, `latestGateDecision`, `promotionSignalDigest`, `promotionSignalSchema`, `promotionSignalRecordSchema`, `PROMOTION_SIGNAL_SCHEMA_VERSION`, `PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS`, `PROMOTION_SIGNAL_EXIT_CODES` | `IssuePromotionSignalOptions`, `PromotionContext`, `PromotionBindings`, `PromotionSignal`, `PromotionSignalRecord`, `PromotionIssueOutcome`, `PromotionVerification`, `PromotionEvidenceReason`, `PromotionResult`, `StaleBinding` |
| `memory-lifecycle/scenarios.ts` | `memoryScenarioSuiteSchema`, `LIFECYCLE_STAGES`, `SCENARIO_CONDITIONS`, `MEMORY_WORKLOADS`, `BENCHMARK_SOURCES` | `MemoryScenario`, `MemoryScenarioSuite`, `ScenarioEvidence` |
| `memory-lifecycle/suite.ts` | `memoryLifecycleSuite`, `parseMemoryScenarioSuite`, `toMemoryLifecycleDataset` | none |
| `memory-lifecycle/baselines/adapter.ts` | `MEMORY_BASELINES`, `SIMPLER_BASELINES`, `STRUCTURED_COMPONENTS` | `MemoryBaselineAdapter`, `MemoryBaselineName`, `StructuredComponent` |
| `memory-lifecycle/baselines/index.ts` | `createBaselineAdapter` | none |
| `memory-lifecycle/envelope.ts` | `MEMORY_LIFECYCLE_LANES`, `memoryLifecycleEnvelope` | `ComputeEnvelope`, `MemoryLifecycleLane` |
| `memory-lifecycle/memory-evaluator.ts` | `memoryLifecycleEvaluator`, `modelJudgingIssues` | none |
| `memory-lifecycle/metrics.ts` | `measureScenarioRun` | `ScenarioMetrics` |
| `memory-lifecycle/suite-run.ts` | `runMemoryLifecycleSuite` | `BaselineRun`, `ComponentAblation`, `MemoryLifecycleSuiteRun` |
| `memory-lifecycle/release.ts` | `bestSimplerBaseline`, `decideMemoryLifecycleRelease` | `MemoryLifecycleRelease` |
| `memory-lifecycle/report.ts` | `buildMemoryLifecycleReport` | `MemoryLifecycleReport` |
| `memory-lifecycle/report-markdown.ts` | `renderMemoryLifecycleReport` | none |
| `memory-lifecycle/artifact.ts` | `replayScenarioArtifact`, `scenarioRunArtifactSchema`, `MEMORY_LIFECYCLE_REPLAY_EXIT_CODES` | `ArtifactReplayOutcome`, `ScenarioRunArtifact` |
| `memory-lifecycle/benchmarks.ts` | `benchmarkAdoptions`, `EXTERNAL_SCORE_POLICY` | `BenchmarkAdoption` |
| `goal-adapter.ts` | `createGoalEvaluatorAdapter` | `CreateGoalEvaluatorAdapterOptions`, `GoalEvaluatorConfiguration`, `GoalEvaluatorAdapter`, `GoalEvaluationOptions`, `GoalEvaluatorVerdict`, `GoalEvaluatorError`, `GoalEvaluatorErrorKind`, `GoalEvaluatorErrorCode` |
| `collaboration-plan.ts` | `collaborationPlanSchema`, `parseCollaborationPlan`, `collaborationPlanDigest`, `collaborationMessageSchema`, `taskClassKey`, `EXECUTION_PROFILES`, `MESSAGE_INTENTS`, `PARTICIPANT_ROLES`, `TASK_CLASSES` | `CollaborationPlan`, `CollaborationParticipant`, `CollaborationArtifact`, `CollaborationMessage`, `ExecutionProfile`, `MessageIntent`, `NamedTaskClass`, `ParticipantRole`, `ResourceEnvelope`, `TaskClass` |
| `comparison-datasets.ts` | `comparisonDatasetSchema`, `parseComparisonDataset`, `comparisonDatasetDigest`, `toEvaluationDataset`, `checkSuccessContract`, `COMPARISON_CONTROLS` | `ComparisonDataset`, `ComparisonCase`, `ComparisonControl`, `SuccessContract`, `SuccessHeuristic`, `SuccessHeuristics` |
| `trajectory.ts` | `measureTrajectory`, `collaborationTrajectorySchema`, `parseCollaborationTrajectory`, `CLEANUP_STATES`, `FAILURE_LABELS` | `CollaborationTrajectory`, `TrajectoryEvent`, `TrajectoryMeasurement`, `CoordinationMetrics`, `CleanupReport`, `CleanupState`, `FailureLabel`, `FailureOccurrence` |
| `comparison.ts` | `runComparison`, `bindComparison`, `comparisonDefinitionSchema`, `comparisonBindingSchema`, `comparisonResultSchema`, `AGGREGATION_KINDS`, `COMPARISON_SCHEMA_VERSION`, `ENVELOPE_BREACHES` | `RunComparisonOptions`, `BindComparisonOptions`, `BoundComparison`, `ComparisonDefinition`, `ComparisonBinding`, `ComparisonResult`, `ComparisonSubjects`, `CollaborationContext`, `CollaborationRun`, `ParticipantContext`, `ProfilePlans`, `CaseComparison`, `ProfileResult`, `ProfileTotals`, `ProfileTrial`, `EnvelopeBreach` |
| `admission.ts` | `decideAdmission`, `parseAdmissionRule`, `admissionRuleSchema`, `admissionDecisionSchema`, `ADMISSION_DECISIONS`, `ADMISSION_FINDING_REASONS` | `AdmissionRule`, `AdmissionDecision`, `AdmissionDecisionKind`, `AdmissionFinding`, `AdmissionFindingReason`, `PooledProfile` |
| `comparison-evidence.ts` | `toComparisonEvidence`, `verifyComparisonEvidence`, `admissionFromEvidence`, `recordedSeeds`, `comparisonEvidenceDigest`, `comparisonEvidenceSchema`, `BINDING_CHANGES`, `COMPARISON_EVIDENCE_SCHEMA_VERSION` | `ComparisonEvidence`, `ComparisonEvidenceOptions`, `CurrentComparison`, `EvidenceCurrency`, `BindingChange` |
| `comparison-report.ts` | `renderComparisonReport`, `REPORT_METRICS` | none |

`src/index.test.ts` pins the runtime export list, so a new value export fails that test until it is added there and here.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/evaluation
bun run --filter=@lostgradient/evaluation test:coverage
bun run --cwd testing/evaluation history list
bun run --cwd testing/evaluation release-gate --gate fixture-regression
bun run --cwd testing/evaluation replay --gate fixture-regression --latest
bun run --cwd testing/evaluation comparison --suite fixture-vault-code --report .cache/vault-code.md
bun run --cwd testing/evaluation promotion-signal issue --gate fixture-regression
bun run --cwd testing/evaluation promotion-signal verify <signalId>
bun run --cwd testing/evaluation memory-lifecycle run --lane deterministic
bun run --cwd testing/evaluation memory-lifecycle run --lane stochastic
bun run --cwd testing/evaluation memory-lifecycle replay <artifact.json>
bun run --cwd testing/evaluation memory-lifecycle baseline
bun run --cwd testing/evaluation release-gate --gate memory-lifecycle
```

`test:coverage` fails below 100 percent line or function coverage of this workspace's `src/` and `scripts/`.
