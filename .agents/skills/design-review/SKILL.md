---
name: design-review
description: 'Use to screenshot Interborough and get an expert design critique or sign-off from the read-only `design-reviewer` agent: a full sweep of every page in its data, empty, loading, error and forbidden states, or a sign-off on the screens a UI change touched. Required before a pull request that changes Interborough UI or Cinder components, tokens, or styles is ready for review. Routes every finding to Cinder (components, defaults, tokens) first and to Interborough only when the problem is the page itself.'
---

# Design review

Capture Interborough's screens, hand them to the `design-reviewer` agent, and turn its findings into work that lands in Cinder first. Interborough is the only application that uses Cinder and exists partly to prove Cinder out, so a defect a Cinder component, default, or token could fix is fixed there, never patched around in the page.

Load a reference when its step comes up: [capture](references/capture.md), [the review rubric](references/rubric.md), [findings and verdicts](references/findings.md), and [design references](references/design-references.md).

## Gotchas

- Screenshots come from the end-to-end harness, not from driving a browser by hand. `bun scripts/design-review-capture.ts` (in `applications/interborough`) reuses `responsive.spec.ts` and `15-view-states.spec.ts`, which already seed every route and force every view state, and writes `manifest.jsonl` beside the images. Use Chrome only for a quick look at one page on the dev server, never for a sweep.
- The seeded "with data" content in `responsive.spec.ts` is deliberately pathological: 300-character unbroken words, a 2,000-character storage key, review titles like "Refund wwww…". It shows how a page survives extreme values, not what a normal day looks like. Tell the reviewer, and judge hierarchy, density and layout from it with that caveat until a realistic showcase seed exists.
- The capture holds the host lock in no way and runs the whole Playwright suite's server. Run at most one capture at a time on the host, in the background, and count it against the AGENTS.md "Parallel runs" limit. A sign-off narrows with `--grep` and `--scheme`; only a sweep runs everything.
- A capture's own specification can fail (an overflow, an axe violation) and still leave its screenshots, because each page is captured before its assertions. `summary.json` says whether the run was clean; pass that to the reviewer, because a failed assertion is itself a finding.
- The reviewer reads images with `Read`, and images are expensive context. Dispatch it once per area with at most about 40 screenshots, viewport captures first and `.full.png` only where the fold matters. Never send it the whole sweep at once.
- The reviewer is read-only and invokes no skills. It cannot open URLs, so the coordinator turns a design reference into local images first ([design references](references/design-references.md)).
- The user's visual report outranks any capture. If the owner says something looks wrong, find it; never answer with a screenshot from a different environment.
- Findings are not tickets. A sweep writes `report.md` in the capture directory; filing it in Linear is the owner's call, and each Interborough issue that depends on a Cinder change is blocked by the Cinder issue.

## Sign-off on a UI change

Any change to `applications/interborough/src/{app,routes,views,styles}` or `components/cinder/src` needs the reviewer's sign-off before its pull request is ready for review. The implementer, whether the primary agent or a worker, does this itself:

- Capture the routes the change touches in the states it touches, at the default widths, in light and dark when color, tokens, or surfaces changed: `bun scripts/design-review-capture.ts --grep '<route or view>'`. A Cinder token or default change captures at least three consuming pages, because a default moves every screen that uses it.
- Capture the same set on the base revision when the change alters existing screens, so the reviewer compares before and after rather than judging in isolation.
- Dispatch `design-reviewer` in sign-off mode with: the issue's acceptance criteria, a one-paragraph summary of the change, the changed files, the manifest paths for after (and before), the design reference images if any, and the pathological-data caveat.
- Act on the verdict ([findings](references/findings.md)). `approve` and `approve with notes` let the pull request proceed; notes inside the change's scope are fixed in the same round, and the rest go in the pull request description. `changes required` lists blocking items; fix them, recapture, and re-dispatch with the previous verdict attached. The AGENTS.md three-round cap applies: after the third round, open items that do not block go into one follow-up issue.
- Record the verdict in the pull request description: the reviewer's verdict line, the round count, and the capture directory.

## Full sweep

Run a sweep when the owner asks for a design audit, before a design milestone, or after a large Cinder change.

Start the capture in the background: `bun scripts/design-review-capture.ts` from `applications/interborough`. Meanwhile, gather the design reference if one exists, as [design references](references/design-references.md) describes.

Group the manifest by area: chat; agents and memory; capabilities; workflows and runs; schedules; reviews, hooks and goals; health, workers, storage and audit; settings; shell and not-found. Dispatch `design-reviewer` in sweep mode per area, at most two at a time, each with its manifest lines, the run's `summary.json`, the design reference images for that area, and the data caveat.

Consolidate the area reports into `report.md` in the capture directory. Deduplicate by root cause, not by screen: a component defect seen on nine pages is one Cinder finding listing nine places. Order it as Cinder tokens and defaults, then Cinder components (existing and new), then Interborough layout and information architecture, then Interborough copy and data, each by severity. Present the top findings to the owner with the report path, and ask before filing anything in Linear.
