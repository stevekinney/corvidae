---
name: design-review
description: 'Use for an expert design review of Interborough by the read-only `design-reviewer` agent, in one of four modes: a sweep of every existing page (data, empty, loading, error and forbidden states) for UI issues; a critique of a proposed design (a Claude Design canvas or claude.ai/design project) before it is built; an implementation review of a pull request against the agreed design, with a verdict per design row; or a drift audit of a whole canvas against the shipped code and screens. Implementation review is required before a pull request that changes Interborough UI or Cinder components, tokens, or styles is ready for review. Routes every finding to Cinder (components, defaults, tokens) first and to Interborough only when the problem is the page itself.'
---

# Design review

Hand Interborough's screens, or a proposed design for them, to the `design-reviewer` agent, and turn its findings into work that lands in Cinder first. Interborough is the only application that uses Cinder and exists partly to prove Cinder out, so a defect a Cinder component, default, or token could fix is fixed there, never patched around in the page.

Pick the mode from what you are given:

| Given | Mode | Section |
| --- | --- | --- |
| "audit the UI", no change in hand | sweep | [Sweep](#sweep) |
| a Claude Design canvas or claude.ai/design project, not yet built | design critique | [Design critique](#design-critique) |
| a pull request, branch, or working change to Interborough UI or Cinder | implementation review | [Implementation review](#implementation-review) |
| an agreed canvas and the question "how much of it shipped?" | drift audit | [Drift audit](#drift-audit) |

Load a reference when its step comes up: [capture](references/capture.md), [the review rubric](references/rubric.md), [findings and verdicts](references/findings.md), and [design references](references/design-references.md).

## Gotchas

- Screenshots come from the end-to-end harness, not from driving a browser by hand. `bun scripts/design-review-capture.ts` (in `applications/interborough`) reuses `responsive.spec.ts` and `15-view-states.spec.ts`, which already seed every route and force every view state, and writes `manifest.jsonl` beside the images. Use Chrome only for a quick look at one page on the dev server, never for a sweep.
- The seeded "with data" content in `responsive.spec.ts` is deliberately pathological: 300-character unbroken words, a 2,000-character storage key, review titles like "Refund wwww…". It shows how a page survives extreme values, not what a normal day looks like. Tell the reviewer, and judge hierarchy, density and layout from it with that caveat until a realistic showcase seed exists.
- The capture holds the host lock in no way and runs the whole Playwright suite's server. Run at most one capture at a time on the host, in the background, and count it against the AGENTS.md "Parallel runs" limit. An implementation review narrows with `--grep` and `--scheme`; only a sweep runs everything.
- Another session's end-to-end server may already hold port 7399, and Playwright would capture it instead of this tree. The capture refuses to start when the port is taken; set `INTERBOROUGH_E2E_PORT` to a free port rather than stopping someone else's server.
- Rows are the unit of agreement. When design rows are given (a rows file from the issue, the chef brief, or the design ledger), the result is one verdict per row in `row-verdicts.txt`, checked by `bun scripts/design-review-rows.ts` before anyone reads it ([findings](references/findings.md) "Row verdicts"). A review that skips a row has failed; `unverified` is never a pass.
- A design reference has to be agreed before an implementation can be held to it. Only canvas rows marked Decided, or a design the owner approved after a design critique, are the standard; Prototyped and Options rows are input, not a contract.
- A capture's own specification can fail (an overflow, an axe violation) and still leave its screenshots, because each page is captured before its assertions. `summary.json` says whether the run was clean; pass that to the reviewer, because a failed assertion is itself a finding.
- The reviewer reads images with `Read`, and images are expensive context. Dispatch it once per area with at most about 40 screenshots, viewport captures first and `.full.png` only where the fold matters. Never send it the whole sweep at once.
- The reviewer is read-only and invokes no skills. It cannot open URLs, so the coordinator turns a design reference into local images first ([design references](references/design-references.md)).
- The user's visual report outranks any capture. If the owner says something looks wrong, find it; never answer with a screenshot from a different environment.
- Findings are not tickets. A sweep writes `report.md` in the capture directory; filing it in Linear is the owner's call, and each Interborough issue that depends on a Cinder change is blocked by the Cinder issue.

## Sweep

Run a sweep when the owner asks for a design audit, before a design milestone, or after a large Cinder change.

Start the capture in the background: `bun scripts/design-review-capture.ts` from `applications/interborough`. Meanwhile, gather the agreed design reference if one exists ([design references](references/design-references.md)).

Group the manifest by area: chat; agents and memory; capabilities; workflows and runs; schedules; reviews, hooks and goals; health, workers, storage and audit; settings; shell and not-found. Dispatch `design-reviewer` in sweep mode per area, at most two at a time, each with its manifest lines, the run's `summary.json`, the reference images for that area, and the data caveat.

Consolidate the area reports into `report.md` in the capture directory. Deduplicate by root cause, not by screen: a component defect seen on nine pages is one Cinder finding listing nine places. Order it as Cinder tokens and defaults, then Cinder components (existing and new), then Interborough layout and information architecture, then Interborough copy and data, each by severity. Present the top findings to the owner with the report path, and ask before filing anything in Linear.

## Design critique

Run a critique on a proposed design before anyone builds it, so problems are caught while they are cheap.

- Turn the design into local images and text as [design references](references/design-references.md) describes, under `tmp/design-review/<time stamp>-critique/design/`: one image per board or screen, plus the canvas's index rows and any notes the designer left.
- Capture the current screens of the same area (`bun scripts/design-review-capture.ts --grep '<area>'`), so the reviewer can say what the design improves, what it regresses, and where it diverges from the rest of the application.
- Dispatch `design-reviewer` in critique mode with the design images (tall boards as their slices), the shared rules board if the canvas has one, the index rows and their status, the current captures, and what the design is meant to achieve (the issue, the canvas's stated goal, or the owner's words).
- The critique also inventories what the design asks of Cinder: existing components it uses, variants or defaults it changes, tokens it moves, and new components it implies. That inventory is how a design becomes Cinder issues that the Interborough issues are blocked by.
- Present the verdict and the inventory to the owner. Comments on the canvas, and edits to it, are the owner's call; the reviewer's report lives in the critique directory.

## Implementation review

Any change to `applications/interborough/src/{app,routes,views,styles}` or `components/cinder/src` needs this review before its pull request is ready for review. The implementer, whether the primary agent or a worker, runs it on its own change; anyone can run it on someone else's pull request.

- For another author's pull request, check its head out in a fresh worktree (`git worktree add ~/.agent-worktrees/claude/<name> <head>`, then `bun install --frozen-lockfile`), and read its linked COR issue for the agreed design and acceptance criteria.
- Capture the routes the change touches in the states it touches, at the default widths, in light and dark when color, tokens, or surfaces changed: `bun scripts/design-review-capture.ts --grep '<route or view>'`. A Cinder token or default change captures at least three consuming pages, because a default moves every screen that uses it.
- Capture the same set on the base revision when the change alters existing screens, so the reviewer compares before and after rather than judging in isolation.
- Gather the agreed design for the change as a rows file and a boards directory ([findings](references/findings.md) "Row verdicts" gives the formats). A chef brief already holds them (`tmp/chef/briefs/<ID>/rows.txt` and `boards/<board>.dc.html`); otherwise write them from the issue's design criteria and the canvas. Render any board that has no `<board>.png` beside its `.dc.html` with `bun scripts/design-review-render-boards.ts`, as [design references](references/design-references.md) describes, because the reviewer judges visuals from the image and exact copy and structure from the HTML. A UI change with no agreed design gets the rubric alone and no rows.
- Dispatch `design-reviewer` in implementation-review mode with: the issue's acceptance criteria, a one-paragraph summary of the change, the changed files, the manifest paths for after (and before), the rows file and boards, and the data caveat. When an area has more than about 40 screenshots or 30 rows, split the rows by board across dispatches and concatenate their lines back in input order.
- Write the reviewer's row lines to `<capture directory>/row-verdicts.txt` and its report to `report.md` there, then run `bun scripts/design-review-rows.ts --mode implementation-review --rows <rows file> --verdicts <capture directory>/row-verdicts.txt` from `applications/interborough`. Exit 1 means the review is malformed: send the problems back to the same reviewer and re-check. The overall verdict is the one the script prints, and it is the first line of `report.md`.
- Act on the verdict ([findings](references/findings.md)). `approve` and `approve with notes` let the pull request proceed; notes inside the change's scope are fixed in the same round, and the rest go in the pull request description. `changes required` lists blocking items; fix them, recapture, and re-dispatch with the previous verdict attached. The AGENTS.md three-round cap applies: after the third round, open items that do not block go into one follow-up issue.
- Record the verdict in the pull request description: the verdict line, the per-verdict counts the script prints, the round count, and the capture directory. A row can be `deferred` only when the issue itself records the deferral with a reason. When reviewing someone else's pull request, post each blocking item as a review comment on the file and line that causes it (the coordinator posts; the reviewer is read-only), never as a top-level comment alone.

## Drift audit

Run a drift audit to find out how much of an agreed canvas actually shipped: when a design programme claims to be finished, before the chef close gate, or when the owner asks.

- Export the canvas's index to a rows file, one line per index row (`bun scripts/chef/design-ledger.ts` with its rows output, when it has one, writes it in this format), and save every board under `boards/` as `<board>.dc.html` and `<board>.png`, as [design references](references/design-references.md) describes. Mark rows the index already records as superseded or dropped, so the reviewer can confirm rather than rediscover them.
- Capture everything: `bun scripts/design-review-capture.ts`, in the background.
- Split the rows by area, matching the sweep's areas, and dispatch `design-reviewer` in drift-audit mode per area, at most two at a time, each with its rows, its boards, its manifest lines, the run's `summary.json`, and the source paths for that area (`applications/interborough/src/routes/<area>/` and the Cinder components its boards use). The reviewer judges each row against the screens first and the code second, because a row can be in the code and still not show.
- Concatenate the area results into `row-verdicts.txt` in input order and run `bun scripts/design-review-rows.ts --mode drift-audit --rows <rows file> --verdicts <capture directory>/row-verdicts.txt`. Exit 1 means rows were skipped or malformed; re-dispatch those rows only.
- Write `report.md`: the counts per verdict, then the drifted, partial, missing and unverified rows grouped by root cause and routed Cinder first, as in a sweep. Every `unverified` row names what would make it checkable (a missing capture state, a flow the dev host cannot run), because a close gate treats it as a miss.
