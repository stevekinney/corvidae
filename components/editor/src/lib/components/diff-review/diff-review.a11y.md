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
- **Human design/accessibility acceptance was not performed in this session.** The ratified contract (COR-511 / DR-8) reserves final design and accessibility acceptance, including manual VoiceOver verification and real-browser download/clipboard checks, for Steve Kinney; no agent may supply it. A Linear comment on COR-509/COR-511 asserts this gate was verbally waived; that comment is itself phrased as a third-person relay of a conversation rather than a first-person statement, and a prior agent comment on this issue found no corroborating record anywhere in Linear or the ratified planning document (which states the opposite: "not waived or claimed accepted"). This session records that waiver claim as **unverified**, not acted on as acceptance. No VoiceOver or other manual screen-reader pass, and no real-browser clipboard/download test, was run against this component in this session.

Related components: `diff-review-comments`, `diff-viewer`, `review-editor`.
