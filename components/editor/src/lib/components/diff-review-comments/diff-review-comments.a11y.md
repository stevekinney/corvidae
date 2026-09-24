# DiffReviewComments · accessibility

## Pattern

Purpose: reusable, resolution-aware comments panel for a `DiffReviewState` session -- every saved comment by default, with an unresolved filter and a review note.

## Use when

- Building a standalone comment panel next to a `DiffViewer` or `SourceDiffViewer` instance.
- Composing the aggregate `DiffReview` shell, which renders this panel internally.

## Avoid when

- Reviewing ProseMirror document threads with author identity -- use ReviewEditor's own comment UI instead.

## Names, roles, and state

- The filter control is a `role="group"` with `aria-label="Comment filter"`; each toggle button exposes its selected state through `aria-pressed`.
- Each comment's resolved/outdated state is rendered as visible text (`Resolved`/`Outdated`), never color alone.
- Edit/Resolve/Reopen/Delete are native `<button>` elements with plain-text labels; Delete opens a `ConfirmDialog` (`title="Delete comment?"`) rather than deleting immediately, and the dialog defaults focus to Cancel.
- The review note is a labelled `<textarea>` (`<label for="diff-review-review-note">`).
- In `readonly` mode, mutating controls (Edit/Resolve/Reopen/Delete, the review-note field) are not rendered/are disabled; the filter and comment list remain fully available.

## Keyboard and focus

Every control is a native, keyboard-operable element (`<button>`, `<textarea>`) — no custom key handling is layered on top, so Tab/Shift+Tab and Enter/Space follow native semantics. `ConfirmDialog` owns its own focus trap and Escape-to-cancel behavior.

## Verification performed this session

- Automated: component tests render the panel and its comment items under `@testing-library/svelte` and assert the filter, resolve/reopen/edit/delete affordances, and `readonly` behavior (`diff-review-comments.test.ts`).
- **Human design/accessibility acceptance was not performed in this session.** The ratified contract (COR-511 / DR-8) reserves final design and accessibility acceptance, including manual VoiceOver/keyboard-matrix verification, for Steve Kinney; no agent may supply it. A Linear comment on COR-509/COR-511 asserts this gate was verbally waived — see this issue's Linear comment for why that assertion is recorded as unverified rather than acted on as acceptance. No VoiceOver or other manual screen-reader pass was run against this component; do not read anything above as a substitute for one.

Related components: `diff-review`, `review-editor`.
