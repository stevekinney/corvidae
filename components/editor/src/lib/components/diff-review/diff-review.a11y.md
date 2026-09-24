# DiffReview · accessibility

DiffReview's nearest neighbors are `DiffViewer` and `SourceDiffViewer`. It is admitted as its own component under the behavior-first admission bar because neither viewer, alone or side by side, provides multi-target file navigation, comment lifecycle (create/edit/delete/resolve/reopen), a drafts inventory, reviewed markers, or Markdown/JSON export -- DiffReview composes their public annotation hooks with `diff-review-state` and the export functions to add that behavior without duplicating either viewer's rendering or reaching into a private controller.

## Pattern

DiffReview packages a higher-level workflow (file navigation, diff comparison, comment creation, drafts, export). Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: aggregate single- and multi-target diff review with comment controls, drafts inventory, and Markdown/JSON export.

## Use when

- Reviewing one or many mixed Markdown/source-patch targets and collecting comments for an agent handoff.

## Avoid when

- Rendering a single diff with no comment/export workflow — use `DiffViewer` or `SourceDiffViewer` directly.

## Regions and names

- File navigation: `<nav aria-label="File navigation">`.
- Diff surface: `<main aria-label="Diff">`.
- Review sidebar (drafts inventory + comments panel): `<aside aria-label="Review">`.
- The path filter is a labelled `<input type="search" aria-label="Filter files by path">`.
- Export scope, Copy, and Download controls sit in a single toolbar; a blocked export replaces them with a `role="status"` message naming the exact pending-draft count and a link back to the drafts inventory, rather than disabling the controls silently.

## Keyboard and focus

Every DiffReview-owned control (file buttons, the Reviewed checkbox, the comment composer, drafts actions, toolbar controls, and comment navigation) is a native, keyboard-operable element. Per-line/per-file comment creation reuses `DiffViewer`'s and `SourceDiffViewer`'s own annotation-hook keyboard model (Enter to start/commit, Shift+Arrow to extend, Escape to cancel) documented in each viewer's own `*.a11y.md` — DiffReview does not add a second competing key handler on top of it. Deleting a comment opens Cinder's `ConfirmDialog`; canceling or confirming returns focus to the "Delete" button that opened it (`ConfirmDialog`'s own behavior, exercised end-to-end in `diff-review-keyboard.test.ts`).

## Comment-to-anchor navigation

A comment's "Go to" action, for a CURRENT comment, calls the mounted viewer's own public `focusAnchor`/`focusFile` (through `DiffReviewRenderer`'s unified handle) — switching target/file and Markdown view mode first as needed, exactly as those viewers already do for their own `ref.focusAnchor`. If the anchor's row isn't rendered, a visible `role="status"` message says so. For an OUTDATED or REMOVED comment, "Go to" never focuses the diff at all: focus moves to that comment's own captured-detail text in place, and a REMOVED comment additionally carries a "Removed" badge (a target no longer present in `state.targets`, distinct from "Outdated," whose target is still live but changed). Saved-comment markers (via `lineAnnotation`/`fileAnnotation`) render for CURRENT comments only — an outdated comment deliberately produces no marker, proven by a mixed-status test in `diff-review-renderer.test.ts`.

## Invalid targets, renderer failure, and empty diffs

An invalid `targets` update shows a `role="alert"` with the structured error and keeps the last valid render. A target whose viewer throws while rendering is isolated behind a `<svelte:boundary>`: a local, scoped error replaces just that pane, its own file-comment control is disabled, and every other target/export is unaffected. A file with zero changed lines shows "No commentable patch lines." instead of the viewer.

## Copy and download announcements

Copying announces success only ("Copied review to clipboard.") through a visually hidden `aria-live="polite"` region. A clipboard failure is rendered as **visible, persistent text** (`role="alert"`), not only announced, and never blocks a subsequent download or mutates state — the failure path and the download path share no state.

## Verification performed this session

- Automated: component tests mount the full composed shell (`diff-review.test.ts`, `diff-review-mount-smoke.test.ts`, `diff-review-navigation.test.ts`, `diff-review-error-states.test.ts`, `diff-review-keyboard.test.ts`) and assert file selection, the file-comment composer, export gating, Reviewed-marker dispatch, comment-to-anchor navigation for current/outdated/removed comments, invalid-target/renderer-failure/no-commentable-lines states, and the keyboard/focus-return matrix; `diff-review-renderer.test.ts` covers the unified `focusAnchor`/`focusFile` handle and current-only inline markers directly. The pure conversion/derivation modules (file entries, filtering, export gate, download, annotation bridge, anchor status, inline markers) have direct unit coverage.
- **2026-09-24 (COR-511, commit `46de156b`), agent-verified, no human review:** added automated axe-core checks (`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, 0 violations) against the composed shell in the light theme, the dark theme, a 320-CSS-pixel narrow viewport, and the read-only state (`#example-mount-readonly`). At 320px, the `File navigation`/`Diff`/`Review` landmark regions and every named control (path filter, Copy review, Download Markdown, Download JSON) remain visible and enabled with no horizontal overflow (`document.documentElement.scrollWidth` never exceeds `clientWidth`). The read-only state renders no "Add file comment" control while Copy/Download remain available. Engine/browser: Chromium (Playwright), desktop 1440×1080 and a 320×900 viewport. See `diff-review-theme-and-narrow-layout.playwright.ts` and the "Diff review — read-only state" describe block in `diff-review.playwright.ts`.
- **Human acceptance: not performed by any human.** The ratified contract (SHA-256 `ac837e3a…`) reserves DR-8 design/accessibility acceptance for Steve Kinney; no agent may supply it. The COR-511 orchestrating session reports Steve waived this gate on 2026-09-23 ("Nothing needs my sign off"); Linear comment `a5463ac9-c4d0-455b-ba01-d30c3fcfdb9a` on COR-511 records the same. This record relies on that report and does not independently verify it — no contract amendment was filed, and a prior agent session on this issue found the claim initially uncorroborated in Linear and in the ratified planning document's own text ("not waived or claimed accepted"). No VoiceOver or other manual screen-reader pass was run against this component in any session; the announcements documented above (copy success/failure) were verified with `role="status"`/`role="alert"` DOM assertions instead, never with a live screen reader.
- **Not verified in this session:** the full DR-8 keyboard matrix observed live (only Enter/Shift+Arrow/Escape are exercised, via the shared viewer annotation-hook tests), current/outdated/removed comment-navigation and the hidden-drafts inventory at the DiffReview browser-test level (both have direct unit coverage only — `diff-review-navigation.test.ts`, `diff-review-drafts-inventory.test.ts`), empty/binary/truncated-target states at the browser-test level (unit coverage only — `diff-review-error-states.test.ts`), and DiffReview/DiffReviewComments-level two-instance isolation (the underlying DiffViewer/SourceDiffViewer annotation-hook isolation is covered by `diff-viewer-annotation.playwright.ts`/`source-diff-viewer-annotation.playwright.ts`).

Related components: `diff-review-comments`, `diff-viewer`, `review-editor`.
