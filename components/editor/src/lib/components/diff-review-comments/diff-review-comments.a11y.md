# DiffReviewComments · accessibility

DiffReviewComments' nearest neighbor is ReviewEditor's own document-thread comment UI. It is admitted as a distinct component because diff comments anchor to old/new diff-line coordinates from `diff-review-state`, not ProseMirror positions, and never assume an author identity the way ReviewEditor's thread model does; it reuses ReviewEditor's composer/action conventions (resolve, reopen, delete-with-confirmation) without importing its ProseMirror-specific anchoring.

## Pattern

Purpose: reusable, resolution-aware comments panel for a `DiffReviewState` session -- every saved comment by default, with an unresolved filter and a review note.

## Use when

- Building a standalone comment panel next to a `DiffViewer` or `SourceDiffViewer` instance.
- Composing the aggregate `DiffReview` shell, which renders this panel internally.

## Avoid when

- Reviewing ProseMirror document threads with author identity -- use ReviewEditor's own comment UI instead.

## Names, roles, and state

- The filter control is a `role="group"` with `aria-label="Comment filter"`; each toggle button exposes its selected state through `aria-pressed`.
- Each comment's resolved/outdated/removed state is rendered as visible text (`Resolved`/`Outdated`/`Removed`), never color alone. `Removed` (its target no longer appears in `state.targets` at all) takes the place of `Outdated` rather than showing both.
- Every comment has a "Go to" action. For a `current` comment this calls the host's `onNavigate`; for `outdated`/`removed`, it instead moves focus to a visible captured-detail line below the comment's meta row (the target label and path it was originally captured against) and never calls `onNavigate` -- the diff is never focused for a stale or gone anchor.
- Edit/Resolve/Reopen/Delete are native `<button>` elements with plain-text labels; Delete opens a `ConfirmDialog` (`title="Delete comment?"`) rather than deleting immediately, and the dialog defaults focus to Cancel.
- The review note is a labelled `<textarea>` (`<label for="diff-review-review-note">`).
- In `readonly` mode, mutating controls (Edit/Resolve/Reopen/Delete, the review-note field) are not rendered/are disabled; the filter and comment list remain fully available.

## Keyboard and focus

Every control is a native, keyboard-operable element (`<button>`, `<textarea>`) — no custom key handling is layered on top, so Tab/Shift+Tab and Enter/Space follow native semantics. `ConfirmDialog` owns its own focus trap and Escape-to-cancel behavior.

## Verification performed this session

- Automated: component tests render the panel and its comment items under `@testing-library/svelte` and assert the filter, resolve/reopen/edit/delete affordances, `readonly` behavior (`diff-review-comments.test.ts`), and comment-to-anchor navigation for current/outdated/removed comments (`diff-review-navigation.test.ts`, composed through `DiffReview`).
- **2026-09-24 (COR-511, commit `46de156b`):** no new automated coverage was added directly against this component this session; it is exercised indirectly (composed inside `DiffReview`) by the light/dark-theme and 320px-narrow-layout axe checks recorded in `diff-review.a11y.md`. It has no standalone-mount axe, theme, or narrow-layout browser test of its own, and no DiffReviewComments-level two-instance-isolation browser test (only unit coverage exists for the behaviors listed above).
- **Human acceptance: not performed by any human.** The ratified contract (SHA-256 `ac837e3a…`) reserves DR-8 design/accessibility acceptance for Steve Kinney; no agent may supply it. The COR-511 orchestrating session reports Steve waived this gate on 2026-09-23 ("Nothing needs my sign off"); Linear comment `a5463ac9-c4d0-455b-ba01-d30c3fcfdb9a` on COR-511 records the same. This record relies on that report and does not independently verify it — no contract amendment was filed. No VoiceOver or other manual screen-reader pass was run against this component in any session; do not read anything above as a substitute for one.

Related components: `diff-review`, `review-editor`.
