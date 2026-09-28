# @lostgradient/evaluation

Scores one completed [Operative](../operative/README.md) run against a versioned evaluator configuration: typed multi-criterion rubrics, hard per-criterion gates, calibration examples for a model judge, and a digest that identifies the configuration exactly. It implements the evaluator configuration, result-class, and inspection-surface sections of the calibrated evaluator contract (COR-896).

This is not an evaluation runner. It never starts a run; it scores the `RunResultBase` you hand it. Repeated trials, variance, disagreement, history, and release gates build on it in later slices.

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
| `repetitions` | Trials per case, at least 1. A model or heuristic judge with `0` or no repetitions is rejected. |
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
  dataset: { version: 'capitals-2026-09', cases: [{ id: 'france', input, expected }] },
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

## Projections

- `toReviewerProjection(evaluation)` is plain JSON with every inspectable fact: identity, configuration (including protected prompt material and reference material), the case and its expected answer, the rubric, unredacted feedback, the tool trajectory, usage, cost, the terminal reason, and any infrastructure error. It is for human calibrators and audit records.
- `toGeneratorProjection(evaluation)` is what may go back to the evaluated system: the verdict, the feedback text, and the names of failing hard criteria. The feedback has the expected answer, every reference material text, and every calibration response removed, because a model judge may quote them.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/evaluation
bun run --filter=@lostgradient/evaluation test:coverage
```

`test:coverage` fails below 100 percent line or function coverage of this workspace's `src/`.
