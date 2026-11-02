# Capture

Run every command from `applications/interborough` in the checkout or worktree under review, after `bun install --frozen-lockfile`.

## The command

```sh
bun scripts/design-review-capture.ts [--out <dir>] [--scheme light|dark|both] [--specs all|responsive|states] [--grep <pattern>]
```

- `--out` defaults to `<repository>/tmp/design-review/<time stamp>`, which Git ignores.
- `--scheme` defaults to `both`, which runs the specifications twice, once per color scheme, through Playwright's `colorScheme`.
- `--specs responsive` captures the seeded pages on every tab; `--specs states` captures the view states; the default captures both.
- `--grep` is Playwright's title filter. Responsive tests are titled by route pattern (`/agents/:agent fits at…`), and view-state tests by view name (`agents is empty at 375 pixels…`), so `--grep 'agents'` takes both for the agent pages. Playwright matches the full title, which begins with the file name, so never anchor a pattern with `^`; a filter that matches nothing exits 1 with no captures.

The capture refuses (exit 2) when the end-to-end port, 7399 unless `INTERBOROUGH_E2E_PORT` says another, is already taken, because Playwright would otherwise reuse whatever server holds it, which on a shared host can be another checkout's build. Set `INTERBOROUGH_E2E_PORT` to a free port with five free after it, at least six away from any other session's.

Exit 0 means at least one capture was written, 1 means none was, and 2 means bad usage or a taken port. `summary.json` records each scheme's Playwright exit code; `clean: false` means a specification failed, and its screenshots are still there.

## What it captures

| Source | Pages | States | Widths |
| --- | --- | --- | --- |
| `tests/e2e/responsive.spec.ts` | every route in `src/app/routes.ts` except redirects, plus named variants (pickers open, a review open, a tab chosen) | ready with seeded data, then each tab the page offers | 375, 768, 1280 |
| `tests/e2e/15-view-states.spec.ts` | each view's index route (`PATHS` in the spec) | loading, empty (when the view can be empty), error, forbidden, ready | 375, 1280 |
| the same | `/health` | refused reads, locked reads, waiting on the engine | 375, 1280 |
| the same | an unknown address | not found | 375, 1280 |

Each manifest line carries `route`, `state`, `tab`, `width`, `height`, `colorScheme`, `address`, `source`, `viewport` (the above-the-fold image) and `full` (the whole outlet, present only when the page scrolls).

## Known gaps

Tell the reviewer about these, and do not let a sweep claim coverage it lacks:

- The seeded data is pathological on purpose (see the skill's gotchas). There is no realistic showcase seed yet.
- Item routes (`/agents/:agent`, `/runs/:run`, …) are captured ready only. Their loading, error and not-found states are not.
- Transient states (a toast, a dialog mid-confirmation, streaming chat output, an offline banner) are not in the sweep. Capture them by hand for an implementation review that changes them: `tests/e2e/states-offline.spec.ts` and the chat specifications show how to reach them, and Chrome on `bun run dev` (port 7234) works for a quick look.
- Hover and focus states are not captured. Focus rings matter to the owner, so a change to them is shown with hand-taken captures.

## A one-page look

For a quick check while iterating, start `bun run dev` and use Chrome (load the `claude-in-chrome` skill) to open the page at 375 and 1280 pixels and screenshot it. It is not a substitute for the capture before an implementation review, because the dev host holds whatever state your local run left behind.
