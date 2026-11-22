# @lostgradient/failure-explanation

Why a run failed, drawn once (COR-2533, COR-2543). The answer `bureau.tasks.explain` gives for a failed run is words and facts; this private source package holds the words of it and the one Cinder component that draws it, so the Interborough Run page and the failure explanation panel of `@lostgradient/plugin-inspectors` read alike.

| Export | What it is |
| --- | --- |
| `@lostgradient/failure-explanation` | `buildExplanationModel`, `failureCategoryLabel`, `failureCategoryTone`, `FAILURE_EXPLANATION_LABELS` and the types `Explanation` and `ExplanationModel`. It imports nothing, and it words nothing: the sentence and the remediation are the server's, and this module names the facts, the badge that draws the category and the guardrail lines. |
| `@lostgradient/failure-explanation/failure-explanation.svelte` | The one component that draws an `ExplanationModel`: the Bureau's sentence, the facts in a two-column list (the cause under its badge, the step, how often it was tried, each guardrail that fired), then what to do next. `showStep={false}` leaves the step out when the host names it in its own heading. |

The package is its own workspace, not a part of `@lostgradient/interborough-plugin`, because the plugin authoring package is a dependency of Bureau, and a server package must not reach a browser component library, Cinder, to run its tests. The component takes `@lostgradient/cinder` as a dependency, and the model, which Bureau never imports, carries no framework code.
