# DiffReview · accessibility

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

Every DiffReview-owned control (file buttons, the Reviewed checkbox, the comment composer, drafts actions, toolbar controls) is a native, keyboard-operable element. Per-line/per-file comment creation reuses `DiffViewer`'s and `SourceDiffViewer`'s own annotation-hook keyboard model (Enter to start/commit, Shift+Arrow to extend, Escape to cancel) documented in each viewer's own `*.a11y.md` — DiffReview does not add a second competing key handler on top of it.

## Copy and download announcements

Copying announces success only ("Copied review to clipboard.") through a visually hidden `aria-live="polite"` region. A clipboard failure is rendered as **visible, persistent text** (`role="alert"`), not only announced, and never blocks a subsequent download or mutates state — the failure path and the download path share no state.

## Verification performed this session

- Automated: component tests mount the full composed shell (`diff-review.test.ts`, `diff-review-mount-smoke.test.ts`) and assert file selection, the file-comment composer, export gating, and Reviewed-marker dispatch; the pure conversion/derivation modules (file entries, filtering, export gate, download, annotation bridge) have direct unit coverage.
- **Human design/accessibility acceptance was not performed in this session.** The ratified contract (COR-511 / DR-8) reserves final design and accessibility acceptance, including manual VoiceOver/keyboard-matrix verification and real-browser download/clipboard checks, for Steve Kinney; no agent may supply it. A Linear comment on COR-509/COR-511 asserts this gate was verbally waived — this issue's Linear comment records that assertion as unverified rather than acted on as acceptance. No VoiceOver or other manual screen-reader pass, and no real-browser clipboard/download test, was run against this component in this session.

Related components: `diff-review-comments`, `diff-viewer`, `review-editor`.
