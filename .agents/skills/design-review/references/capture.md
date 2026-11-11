# Capture

Run every command from `applications/interborough` in the checkout or worktree under review, after `bun install --frozen-lockfile`.

## The command

```sh
bun scripts/design-review-capture.ts [--out <dir>] [--scheme light|dark|both] [--data showcase|stress|both] [--specs all|responsive|states] [--grep <pattern>]
```

- `--out` defaults to `<repository>/tmp/design-review/<time stamp>`, which Git ignores.
- `--scheme` defaults to `both`, which runs the specifications twice, once per color scheme, through Playwright's `colorScheme`.
- `--data` chooses the content the pages hold. `showcase` captures every route with believable content (`tests/e2e/showcase.spec.ts`) and the shell's chrome in each form (`tests/e2e/shell-chrome.spec.ts`), the search palette (`tests/e2e/shell-search.spec.ts`) and Home on a fresh installation (`tests/e2e/first-run.spec.ts`); `stress` captures the pathological seed and the view states (`responsive.spec.ts` and `15-view-states.spec.ts`); `both`, the default, captures all six.
- `--specs responsive` captures the stress-seeded pages on every tab and `--specs states` captures the view states. It narrows the stress data, so on its own it means `--data stress`, and it is refused with `--data showcase`.
- `--grep` is Playwright's title filter. Responsive tests are titled by route pattern (`/agents/:agent fits at…`), and view-state tests by view name (`agents is empty at 375 pixels…`), so `--grep 'agents'` takes both for the agent pages. Playwright matches the full title, which begins with the file name, so never anchor a pattern with `^`; a filter that matches nothing exits 1 with no captures.

The capture refuses (exit 2) when the end-to-end port, 7399 unless `INTERBOROUGH_E2E_PORT` says another, is already taken, because Playwright would otherwise reuse whatever server holds it, which on a shared host can be another checkout's build. Set `INTERBOROUGH_E2E_PORT` to a free port with six free after it, at least seven away from any other session's.

Exit 0 means at least one capture was written, 1 means none was, and 2 means bad usage or a taken port. `summary.json` records each scheme's Playwright exit code; `clean: false` means a specification failed, and its screenshots are still there.

## The two data sets

- Showcase (`fixtures/sample-world-seed.ts`) is the boards' sample world (`tmp/design-review/decisions.md`) at Monday, Nov 2, 10:45 AM: six built-in agents, five chats (two waiting on you, one ended by a restart), Tool runner's four versions and memories, three workflow files (Order refund can't load), four schedules, the twenty runs those and three goals left, five hooks, the GitHub tool source, the plugins' states, a firing storage alert, and the audit entries those leave. Judge layout, hierarchy and density from it. No word in its workflow files is longer than 40 characters, by a test.
- Stress (`responsive.spec.ts`) is pathological on purpose: 300-character unbroken words, a 2,000-character storage key, review titles like "Refund wwww…". Judge overflow and truncation from it, and nothing else.

The same showcase content loads into a running development host with `bun run dev -- --showcase` (below).

## What it captures

| Source | Pages | States | Widths |
| --- | --- | --- | --- |
| `tests/e2e/showcase.spec.ts` | every route in `src/app/routes.ts` except redirects, plus named variants (a chat with a waiting approval, a failed run, an attachment; an agent's tabs; a run that failed, was cancelled, is running; a review open; a paused schedule; a failed hook) | ready with believable content | 375, 768, 1280 |
| `tests/e2e/shell-chrome.spec.ts` | the shell on its own: the 190px sidebar, the collapsed rail with its tooltip, the rail's overlay, the phone and touch-tablet drawer, a back button, 320 pixels and 200% text | each named state | 375 to 1280, and 320 |
| `tests/e2e/shell-search.spec.ts` | the search palette: with nothing typed, for "refund", and as a phone's bottom sheet | each named state | 375 and 1280 |
| `tests/e2e/responsive.spec.ts` | every route in `src/app/routes.ts` except redirects, plus named variants (pickers open, a review open, a tab chosen) | ready with the stress data, then each tab the page offers | 375, 768, 1280 |
| `tests/e2e/15-view-states.spec.ts` | each view's index route (`PATHS` in the spec) | loading, empty (when the view can be empty), error, forbidden, ready | 375, 1280 |
| the same | `/health` | refused reads, locked reads, waiting on the engine | 375, 1280 |
| the same | an unknown address | not found | 375, 1280 |

Each manifest line carries `route`, `state`, `tab`, `width`, `height`, `colorScheme`, `address`, `source`, `viewport` (the above-the-fold image), `full` (the whole outlet, present only when the page scrolls) and `geometry` (what the page measured; `geometryError` instead when the probe threw).

## The geometry audit

After each screenshot the capture measures the page (`tests/e2e/design-review-geometry-probe.ts`) and writes the facts to `geometry/<slug>.json`: each control's box and the box of the label and icons inside it, the sizes and line heights text is set in, each border's width and its contrast against the surface outside it, the left edges text starts on, the gaps between stacked siblings, and wide rows whose content starts far from their leading edge. When the run ends, `scripts/design-review-geometry.ts` holds those facts to `GEOMETRY_THRESHOLDS` and writes two files beside the manifest:

- `geometry-report.md`: one section per rule that was broken, one line per defect, with what was measured, how many captures show it, at which widths and routes, and up to five screenshots. One defect on forty captures is one line.
- `geometry-findings.json`: the same lines as data, with the thresholds they were held to.

`summary.json` carries the counts under `geometry`. To hold an existing capture to changed thresholds without capturing again, run `bun scripts/design-review-geometry.ts --capture <capture directory>` (exit 1 when the directory holds no measured capture).

The stress captures are measured too, but the rules that read content (`button-wordy`, `leading-space`) skip them. The left-edge rule counts blocks of text, not controls or icons, and the leading-side rule looks only at rows at least 60% of the outlet's width and at most 240 pixels tall.

## Known gaps

Tell the reviewer about these, and do not let a sweep claim coverage it lacks:

- The stress data is pathological on purpose, so it says nothing about hierarchy or density. Use `--data showcase` for those.
- The showcase content is what the seed creates, nothing more. The e2e host has no connected tool sources or live workers of its own beyond the suite's fixtures, and the model provider is a stub that gives every model call one fixed reply, so a chat with a file agent shows the same sentence each turn.
- Item routes (`/agents/:agent`, `/runs/:run`, …) are captured ready only. Their loading, error and not-found states are not.
- Transient states (a toast, a dialog mid-confirmation, streaming chat output, an offline banner) are not in the sweep. Capture them by hand for an implementation review that changes them: `tests/e2e/states-offline.spec.ts` and the chat specifications show how to reach them, and Chrome on `bun run dev` (port 7234) works for a quick look.
- Most captures run Desktop Chrome at a narrow width, without touch, so styles under `@media (pointer: coarse)` (touch-sized rows, extended hit areas) do not apply to them. The geometry report says when no capture emulated a coarse pointer; phone target sizes are then the mouse layout's, and a touch-only defect needs a spec that sets `hasTouch`.
- Hover and focus states are not captured. Focus rings matter to the owner, so a change to them is shown with hand-taken captures.

## A one-page look

For a quick check while iterating, start `bun run dev -- --showcase` and use Chrome (load the `claude-in-chrome` skill) to open the page at 375 and 1280 pixels and screenshot it. The showcase host keeps its state in `tmp/interborough-showcase` in the repository (or in `INTERBOROUGH_SHOWCASE_HOME`, when that is set; it ignores `INTERBOROUGH_HOME`), never in the real `~/.interborough`. It turns the demo plugin on, so the scripted agents (`demo:assistant`, `demo:tool-runner`, `demo:request-human-input`) answer chats, and it connects a stub model provider with two models, so the model picker has a choice; no real provider key is used. Once it listens, it fills itself with the showcase content and prints one line saying what it created; a second start against the same home creates nothing. Delete `tmp/interborough-showcase` to start over. It is still not a substitute for the capture before an implementation review, because a host you have clicked around in holds whatever state you left behind.

A plain `bun run dev` holds the real home's data, or none.
