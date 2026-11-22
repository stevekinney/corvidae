# @lostgradient/plugin-inspectors

An Interborough plugin that contributes four interface panels, MCP App pages the host builds at startup and serves as `ui://` resources.

| Panel | Resource | Linked tool | What it shows |
| --- | --- | --- | --- |
| `inspectors:run-inspector` | `ui://inspectors/run-inspector/v1` | `bureau.tasks.inspect` | One task's liveness, ownership tree, progress, result, and abort. It also reads `bureau.tasks.events` and aborts through `bureau.tasks.cancel`. |
| `inspectors:pending-review` | `ui://inspectors/pending-review/v1` | `bureau.reviews.list` | The caller's pending reviews: approve, deny, or reject with feedback. It also reads `bureau.reviews.get` and decides through `bureau.reviews.resolve`. |
| `inspectors:workflow-revision-review` | `ui://inspectors/workflow-revision-review/v1` | `bureau.workflows.update` | A proposed workflow revision, compared with the current one, which the caller can apply. It also reads `bureau.workflows.get`; applying goes through the host-only `bureau.workflows.update`. |
| `inspectors:run-comparison` | `ui://inspectors/run-comparison/v1` | `bureau.runs.compare` | A forked workflow run beside its source: the steps the fork kept as shared and collapsed, the steps it ran again marked changed, the same or in one run only, and a selected step's input and output differences in Cinder's `JsonDiffViewer`. It reads `bureau.runs.compare` and follows `nextCursor` to the last page; a run that is not a fork shows the server's message. |

The run inspector and the run comparison declare a `run` placement, so a run's page mounts them, and the workflow revision review declares a `chat-tool` placement for `bureau:workflows-propose-update`, so Chat opens it when an agent proposes an update. The pending-review list declares none.

Each panel names a browser entry (`src/run-inspector/app.ts`, `src/pending-review/app.ts`, `src/workflow-revision/app.ts`, `src/run-comparison/app.ts`) rather than a built page. The host bundles the entry and the plugin's `styles` into one self-contained document with the script inline, and serves it under a content security policy that denies every origin and permission. The version is part of each URI: a changed contract is a new one. `opensFromTool` is the one tool a client runs to open a panel, and the host links only that tool to the page. `allowedTools` lists every tool the page calls, and a test scans each page's source so the list cannot drift.

Every panel is a Svelte component that renders Cinder through `@lostgradient/cinder/panel`, whose stylesheet reads the host's theme variables with Cinder's own values as the fallback, so the panels follow the owner's theme in light and dark. `src/host-theme.ts` applies the host's theme, style variables and fonts on connect and on every change, the same way for all four. Each panel's script (`app.ts`) holds the bridge and every `bureau.*` call; its component (`inspector.svelte`, `review-list.svelte`, `revision-review.svelte`, `comparison.svelte`) draws a view (`view.svelte.ts`) the script updates, in place, so a poll never moves the reader's focus. The page models (`model.ts`) are plain code with their own tests, and the components are tested against a DOM, so a panel's behavior is checked without a host. The Playwright specs that load the built pages in a sandboxed frame, in the host's light and dark themes, live in `applications/interborough/tests/panels`.

A panel is a document in a frame, so it cannot do what only the application's own interface can. What each of the four could not do inside it:

- The run inspector shows the run and aborts it through the bridge, but it cannot link to the run's page or to a child run, because the host's bridge refuses `ui/open-link`. The ownership tree is text.
- The pending-review list decides a review in the frame, but it cannot raise a notification or open the run a review belongs to. Its reject box is an inline form, not a dialog, because a dialog would stay inside the frame and could not cover the host.
- The workflow revision review compares and applies in the frame, but it cannot open the workflow's own page to edit it, and a long comparison scrolls inside the frame rather than in the host.
- The run comparison shows the fork's steps and their differences in the frame, but it cannot link to the source run or open the fork's page, because the host's bridge refuses `ui/open-link`, so both runs are named in text. A run's page mounts its run panels for a run that has a task, which is an agent run and never a fork, and not yet for a workflow instance, so there a run that is not a fork shows the server's message instead of a comparison.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/inspectors`.
