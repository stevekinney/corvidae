# Diff review: accepted-case table (COR-509 / DR-6)

The ratified contract's ownership amendment assigns COR-509 (DR-6) "a fixture table linking all accepted edge cases to the implementation tests" from COR-516 (DR-2, state/persistence), COR-515 (DR-3, `SourceDiffViewer` annotation hooks), COR-514 (DR-4, `DiffViewer` annotation hooks), and COR-513 (DR-5, exporters). This table is that deliverable: every edge case named in `diff-review-contract.md`'s "Data and revision contract," "Agent export contract," and "Normative implementation handoff" sections, linked to the real test file and `describe` block that proves it, plus this issue's own composition-level tests where the case is a `DiffReview`/`DiffReviewComments` concern rather than a lower-layer one.

No fixture function here is copied or reimplemented; every row names a test that already exists at the path shown.

## Identity, schema, and validation (COR-516)

| Edge case | Test |
| --- | --- |
| Content identity is the fixed-tuple SHA-256 hash; label/path/revision/order/mode/`maxLines` excluded | `diff-review-state/identity.test.ts` — `DiffReview state identity` |
| `createDiffReviewState` builds valid initial state; rejects invalid initial target lists without an empty-success state | `diff-review-state/create.test.ts` — `DiffReview state create` |
| Duplicate target/comment/draft IDs return `duplicate-id` | `diff-review-state/validate-targets.test.ts`, `diff-review-state/reduce-comments.test.ts` |
| Invalid line-range anchors (reversed/out-of-hunk/cross-side/cross-file) return `invalid-anchor` | `diff-review-state/validate-anchor.test.ts` — `DiffReview state anchor validation` |
| Invalid/noncanonical/inverted timestamps return `invalid-timestamp`; update uses later of creation/previous update | `diff-review-state/clock.test.ts` |
| A draft/comment referencing an absent target requires complete captured context, else `missing-context` | `diff-review-state/reduce-targets.test.ts`, `diff-review-state/restore.test.ts` |
| `readonly` disables create/edit/delete/resolve/reopen/reviewed/draft actions; handlers return `{ok:false, error:{code:'readonly'}}` | `diff-review-state/reduce-readonly.test.ts` — `DiffReview state readonly mode` |
| Restore validates completely before any state change; unsupported version/duplicate ids/invalid records are atomic and non-partial | `diff-review-state/restore.test.ts` — `DiffReview state restore` |
| Serialization round-trips comments, drafts, review note, selected target/file, reviewed markers | `diff-review-state/serialize.test.ts` |
| Pure modules run without DOM globals or module-level shared state (SSR) | `diff-review-state/ssr.test.ts` |
| Reviewed-marker invalidation on content/normalization change; target removal deletes markers, reintroduction starts unreviewed | `diff-review-state/reduce-targets.test.ts`, `diff-review-state/query.test.ts` |
| Draft retention across navigation; whitespace-only drafts cannot be saved but don't block export | `diff-review-state/reduce-drafts.test.ts` — `DiffReview state drafts` |
| Nonempty-draft export gate (`drafts-pending`) | `diff-review-state/query.test.ts` (`getDiffReviewPendingDrafts`); composed at the UI layer in `diff-review/diff-review-export-gate.test.ts` (COR-509) |

## Source-diff annotation hooks (COR-515, `SourceDiffViewer`)

| Edge case | Test |
| --- | --- |
| Pointer (click + Shift-click, never drag) and keyboard (Enter/Shift+Arrow/Escape) selection produce the same payload | `source-diff-viewer.annotation-hooks.test.ts` — `pointer and keyboard annotation selection` |
| Additions/removals/unchanged-context side numbering | `source-diff-viewer.annotation.test.ts` — `isLineCommentable / commentableSidesForLine` |
| Cross-file/cross-hunk/cross-side extension is rejected without moving the origin | `source-diff-viewer.annotation.test.ts` — `extendLineSelection` |
| File occurrence/hunk occurrence assigned before display pruning; survive `maxLines` and `activeFileOccurrence` changes | `source-diff-viewer.annotation-hooks.test.ts` — `onFilesChange and activeFileOccurrence` |
| Fully truncated files still get a file-comment hook and header | `source-diff-viewer.annotation-hooks.test.ts` — `onFilesChange and activeFileOccurrence` |
| `ref.focusFile` / `ref.focusAnchor` return `{status:'focused' | 'unavailable'}` | `source-diff-viewer.annotation-hooks.test.ts` — `ref.focusFile / ref.focusAnchor` |
| Two instances do not share selection/shortcuts | `source-diff-viewer.annotation-hooks.test.ts` — `controlled annotationSelection as the extension origin` |
| Default rendering has no annotation controls when the props are absent | `source-diff-viewer.annotation-hooks.test.ts` — `default rendering has no annotation controls` |
| DR-6 consumes only this public API (no private controller import) | `diff-review/diff-review-renderer.test.ts` (COR-509) asserts against `SourceDiffViewer`'s public `focusFile`/`focusAnchor`/`annotationSelection` only |

## Markdown-diff annotation hooks (COR-514, `DiffViewer`)

| Edge case | Test |
| --- | --- |
| Unified/Final/Original modes emit correct side/coordinate-space data | `diff-viewer.annotation.test.ts` — `annotation line numbering`, `side commentability` |
| Modified old/new text independently selectable; unchanged rows commentable | `diff-viewer.annotation.test.ts` — `building and extending selections` |
| Hunk-occurrence identity stable across mode/navigation | `diff-viewer.annotation.test.ts` — `hunk-occurrence identity` |
| Normalized Markdown never labeled raw; `rawMapping: {status:'unavailable', reason:'normalization'}` | `diff-viewer.annotation.test.ts` — `coordinate space and raw mapping` |
| Ambiguous/front-matter-only locations offer file comments with field context, not line comments | `diff-viewer.annotation-hooks.test.ts` |
| Stale diff disables line creation only; saved comments remain available | `diff-viewer.annotation-hooks.test.ts` |
| Two instances remain independent, no shared control ID | `scripts/browser-fixtures/tests/diff-viewer-annotation.playwright.ts` — `an annotation selection in one instance never affects a second instance`, `the two instances never share a control id` |
| DR-6 consumes only this public API | `diff-review/diff-review-renderer.test.ts` (COR-509) asserts against `DiffViewer`'s public `focusAnchor`/`annotationSelection` only |

## Export literalness (COR-513)

| Edge case | Test |
| --- | --- |
| Byte-exact golden fixtures: two source targets with repeated paths, Markdown target, normalized/raw coordinates, file comments, review note, resolved/outdated, missing raw mapping, empty review, malicious-looking/fenced text | `export/diff-review-export-golden.test.ts` — `DiffReview export golden fixtures` |
| Fence length is `max(3, longest run + 1)`; arbitrary backticks/HTML-looking text never interpreted | `export/diff-review-export-fence.test.ts` |
| Deterministic ordering: file-level first, then side/range, then creation time/ID | `export/diff-review-export-ordering.test.ts` |
| Existing-document-thread variant: `deletedAt` predicate, surviving replies after a deleted initial message, always-open scope | `export/diff-review-export-document-threads.test.ts` — `DiffReview export document threads validation` |
| Interpolated source-line map never emits a raw range | `export/diff-review-export-interpolation.test.ts` |
| Markdown structural shape (title, scope, totals, sections) | `export/diff-review-export-markdown.test.ts` |
| JSON `schemaVersion: 1`, exact captured anchor context, no loss | `export/diff-review-export-json.test.ts` |
| Malformed input / invalid scope returns a named error atomically (no partial output) | `export/diff-review-export-validation.test.ts` |

## Composition-level cases owned by this issue (COR-509, `DiffReview`/`DiffReviewComments`)

| Edge case | Test |
| --- | --- |
| Comment-to-anchor navigation for current comments, including a Markdown→source target-kind crossing | `diff-review/diff-review-navigation.test.ts` |
| Outdated/removed comments focus captured detail instead of a stale anchor; unavailable anchors marked visibly | `diff-review/diff-review-navigation.test.ts` — `"Go to" on an outdated comment focuses its own captured detail, never the diff`, `"Go to" on a removed comment ... focuses captured detail and shows "Removed"`, `"Go to" on a current comment whose anchor has no focus target ... is marked unavailable` |
| Invalid `targets` update: structured error shown, last-valid state retained | `diff-review/diff-review-error-states.test.ts` |
| Renderer failure: scoped `<svelte:boundary>` recovery on switching targets, not just first-catch | `diff-review/diff-review-renderer.test.ts` — `a target that throws while rendering shows a local, scoped error instead of crashing`, `reports the failure via onRendererFailedChange, and recovers when switched to a working target` |
| "No commentable patch lines" | `diff-review/diff-review-error-states.test.ts` |
| Inline saved-comment markers render for CURRENT comments only (mixed current/outdated on one file) | `diff-review/diff-review-renderer.test.ts` |
| Keyboard matrix (file list, filter, Reviewed, toolbar, drafts inventory, comment actions, delete-confirmation focus return) | `diff-review/diff-review-keyboard.test.ts` |
| Narrow stacked layout with labelled landmark regions | `diff-review/diff-review-keyboard.test.ts` — `DiffReview component shell: narrow stacked layout with labelled regions` |
| Copy-all includes hidden-file and resolved/outdated comments; clipboard failure leaves download/state intact | `diff-review/diff-review.test.ts`; browser-level clipboard success/failure in `scripts/browser-fixtures/tests/diff-review.playwright.ts` |
| Drafts survive navigating to a different target/file (state-level) | `diff-review-state/reduce-drafts.test.ts` — `draft text and selection survive navigating to a different target/file` |
| A partially written comment survives a path-filter change and remount (component-level) | `diff-review/diff-review.test.ts` — `a partially written comment survives a path-filter change and remount` |
| Hidden (filtered-out) drafts surface in the drafts inventory with Open/Save/Discard | `diff-review/diff-review-drafts-inventory.test.ts` |
