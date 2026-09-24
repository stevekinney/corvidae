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

## 2026-09-24 (COR-511 continuation, commit `2f3a76a6`), agent-verified, no human review

Closes every gap the prior entry above listed as unverified, with new real-browser Playwright specs (Chromium via Playwright, desktop 1440×1080 unless noted). No source defect was found while writing these tests — every assertion below passed on first execution against the shipped `diff-review.svelte`/`diff-review-*` modules; none required a source change.

**Keyboard matrix — DiffReview's own controls** (`diff-review-keyboard-matrix.playwright.ts`; the underlying viewers' own Enter/Shift+Arrow/Escape annotation model remains covered by `diff-viewer-annotation.playwright.ts`/`source-diff-viewer-annotation.playwright.ts` and is not repeated here):

| # | Starting focus | Key | Observed resulting focus / effect |
| --- | --- | --- | --- |
| 1 | Filter files by path | Tab | Export-scope `<select>` |
| 2 | Export-scope `<select>` | Tab | "Copy review" button |
| 3 | "Copy review" | Tab | "Download Markdown" |
| 4 | "Download Markdown" | Tab | "Download JSON" |
| 5 | "Download JSON" | Tab | First file-list button |
| 6 | First file-list button | Tab | Its "Reviewed" checkbox |
| 7 | "Reviewed" checkbox | Tab | "Add file comment" button |
| 8 | "Reviewed" checkbox (focused) | Space | Checked state toggles (native checkbox semantics; no separate live-region announcement exists or is required — the contract does not name one for this control) |
| 9 | A file-list button (focused) | Enter | Activates identically to a click (`aria-current="true"`) |
| 10 | Open composer textarea | Tab | "Save" |
| 11 | "Save" | Tab | "Cancel" |
| 12 | A saved comment's "Go to" | Tab | "Edit" |
| 13 | "Edit" | Tab | "Resolve" |
| 14 | "Resolve" | Tab | "Delete" |
| 15 | "Delete" (focused, then activated) | Escape (on the opened `ConfirmDialog`) | Dialog closes; focus returns to the "Delete" button that opened it; the comment is not deleted |
| 16 | Drafts-inventory item "Open" | Tab | "Save" |
| 17 | Drafts-inventory item "Save" | Tab | "Discard" |
| 18 | (anywhere in the mount) | — | "Review note" `<textarea>` is independently focusable via its `<label for>` association |

Case 15 is new coverage beyond `diff-review-keyboard.test.ts`'s unit-level `fireEvent.click`-only version: it drives a real `Escape` keypress against Cinder's real `ConfirmDialog` and asserts real DOM focus, not a simulated event.

**Hidden-draft inventory** (`diff-review-drafts-inventory.playwright.ts`): two nonempty drafts in the same mixed-target session — one on a target no longer the one displayed in the diff pane, one whose file entry the path filter has hidden from the file-navigation list — both still appear in "Unsaved drafts," in exactly this order of interaction: gate blocks export with `role="status"` text "1 unsaved draft must be saved or discarded before export." (singular, one draft), then "2 unsaved drafts must be saved or discarded before export." (plural, two drafts) — exactly one such node exists at each point, never duplicated. Open switches to the hidden draft's own target/file and reopens its composer with the exact saved body. Save and Discard each resolve one draft and the gate text/count updates accordingly; once both are resolved, Copy/Download reappear.

**Current, outdated, and removed comment navigation** (`diff-review-navigation.playwright.ts`): a real host update via `reduceDiffReviewState`'s `set-targets` action (the same path a real host, e.g. ReviewEditor, uses) drives the transition. "Go to" on a `current` line comment moves real DOM focus to its live annotation control. A `current` **file**-level comment on a Markdown target proves the separate "unavailable" path: `focusFile` has no per-file target on a continuous Markdown document, so "Go to" instead surfaces `role="status"` text "That comment's location isn't available in the current view." exactly once, and that status clears on the next successful navigation. Once the target's content changes, the same line comment becomes `outdated` (badge "Outdated"); "Go to" now focuses only the comment's own captured-detail text (`tabindex="-1"`), proven by an explicit negative assertion that no `[data-cinder-annotation-control]` anywhere in the mount is focused afterward. Once the target is removed entirely, status becomes `removed` (badge "Removed", file list empty, diff pane "No file selected."); "Go to" still only ever focuses the captured detail, and the comment remains visible, editable, and exportable.

**Empty, binary, truncated, invalid-target, and stale states** (`diff-review-error-states.playwright.ts`): a session with zero targets shows "No file selected." and still exports; a file with no changed lines shows "No commentable patch lines." with file-level comment creation still enabled; a binary-only source file (`Binary files a/… and b/… differ`) has `0 changed`, renders no `[data-cinder-annotation-control]`, and still accepts a file-level comment — DiffReview does not render a distinct "binary" message beyond the same "No commentable patch lines." empty state a zero-line text file gets, which is the existing, unchanged behavior and not something this session altered; a >1000-row source patch surfaces `SourceDiffViewer`'s own "Showing first N of M diff lines." `role="status"` notice inside DiffReview, with rendered rows still commentable; an invalid `targets` update shows exactly one `role="alert"` containing `invalid-target` and keeps the last valid file list, clearing on the next valid update; a Markdown target grown past the 100KB manual-tier threshold mid-session shows the existing "The diff is outdated. Recompute it to add a new comment; existing comments remain available." text, disables only the (already-disabled-by-DiffViewer) line-level controls, keeps the earlier saved comment and "Add file comment" available, and "Compute Diff" re-enables line creation.

**Two-instance isolation** (`diff-review-isolation.playwright.ts`): a comment saved in one `DiffReview` mount never appears in three other mounts on the same page (including two sharing identical Markdown content); toggling "Unresolved only" in one instance's comments filter never changes another's `aria-pressed` state; each instance's "Review note" field has a distinct DOM id and independent value.

**Announcements verified via DOM/live-region assertions (VoiceOver was not driven in this or any prior session on this component):**

| Event | Mechanism | Verified as |
| --- | --- | --- |
| Reviewed checkbox toggled | Native `<input type="checkbox">` semantics | Checked-state DOM change only; no separate live region exists or is required |
| Drafts-pending count changes | `role="status"` in the toolbar | Exact node count (1) and exact text at each transition |
| Invalid-target update | `role="alert"` | Exact node count (1) and text containing `invalid-target` |
| Navigation-unavailable | `role="status"` | Exact node count (1) and exact text, clearing on the next successful navigation |
| Mid-session staleness | Existing DiffViewer explanation text | Present exactly once, verbatim |
| Copy success / failure | `role="status"` / `role="alert"` (already covered by `diff-review.playwright.ts`) | Not re-verified this session; unchanged |

Light/dark theming and the 320px stacked layout for DiffReview were already covered by the prior `46de156b` entry above and are not repeated here.

**ReviewEditor diff-integration theme/320px** (`review-editor-diff-theme-and-narrow-layout.playwright.ts`, recorded fully in `review-editor.a11y.md`): light/dark axe checks and a 320px reachability + axe check for the diff tab, now covering the one gap the prior `review-editor.a11y.md` entry named as missing.

**Human acceptance: waived, not performed, by Steve Kinney.** Linear comment `a5463ac9-c4d0-455b-ba01-d30c3fcfdb9a` on COR-511, read directly by this agent with `list_comments` (not merely reported secondhand): "Human acceptance gate waived by Steve Kinney (2026-09-23). In the Claude Code session running this project, Steve said: 'Nothing needs my sign off.' Agents perform the full automated verification … Record in each `*.a11y.md` that human acceptance was waived, not performed." No human reviewed this work; nothing above should be read as a substitute for that review. VoiceOver was not driven in this session — see the announcement table above for what was verified instead.

Related components: `diff-review-comments`, `diff-viewer`, `review-editor`.
