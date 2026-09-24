# Diff review contract

COR-516 (DR-2, "Implement revision-bound diff-review state and persistence") requires this document as part of its deliverable: a transcription of the ratified Cinder diff-review product/architecture contract and its ownership amendment, so implementers do not depend on Linear or conversation history to build against it.

- **Accepted proposal, SHA-256:** `ac837e3a3ddb9b01fb2363147d3172ac27da7ee7abd95c3e87bd44ab12dc0945`
- **Ownership amendment, SHA-256:** `e9858c1d29691663f7b9a5d4d49a2d44b29ca9a13b6fae96b04438f78f292f86`
- **Linear project:** [Cinder: Diff review and agent handoff](https://linear.app/lost-gradient/project/cinder-diff-review-and-agent-handoff-b8e4cf1ce5d8/overview)
- **Linear document (full plan, review ledger, and amendment):** [Diff review signed-off project plan and five-reviewer evidence](https://linear.app/lost-gradient/document/diff-review-signed-off-project-plan-and-five-reviewer-evidence-df4c4cfea5bd)

The project originated in the retired standalone `stevekinney/cinder` repository and its issue IDs (`CIN-554`..`CIN-562`) were translated into this workspace's Corvidae issues (`COR-508`, `COR-509`..`COR-516`) with matching `DR-1`..`DR-9` aliases. `packages/editor` there is `components/editor` here; `packages/components` there is `components/cinder` here.

No product or API decision is reopened by this document. It transcribes the ratified contract; it does not re-litigate it. Implementers translate these choices into types, fixtures, and code.

## Ownership amendment (binding)

The coordinator ratified the complete product and architecture contract below at the accepted proposal SHA. No product/API decision remains queued for a later decision ticket. DR-1 (`COR-508`) is Done — its sole deliverable was this durable ratified decision record; it never claimed source implementation, a merged pull request, prototype acceptance, or publication.

Decisions made and ratified:

- Support one or many mixed Markdown/source targets with stable target/snapshot/file identities.
- Editor owns exactly the `DiffReview` and `DiffReviewComments` public leaves plus pure controlled state and exports. Cinder exposes optional annotation/navigation hooks and never imports Editor.
- Diff old/new line anchors are kept separate from ProseMirror document anchors — no model migration, new diff engine, or fuzzy reanchoring. Content changes latch old comments/drafts outdated.
- Ship exact range gestures, file comments, resolved/reopened comments, reviewed markers, hidden draft inventory, read-only behavior, and unavailable-anchor navigation.
- Use the fixed-tuple SHA-256 identity, version-1 persistence, atomic validation, and source-provenance rules described below.
- Default to all retained saved comments (including resolved/outdated/hidden) in deterministic literal export; nonempty drafts block export until saved or explicitly discarded.
- Single-player only: no multiplayer, identity, presence, remote synchronization, Git operations, or automatic agent transport.

**DR-2 (`COR-516`, this issue)** additionally owns:

- This contract document, transcribing the ratified contract and the ownership amendment, linking both SHAs above.
- Shared typed input/state/error declarations, and valid/invalid identity/state fixtures, that later issues (DR-3 through DR-9) reuse rather than redefining.
- `bunx prettier --check` on this document, alongside the existing focused state tests and typecheck gates.

No new product choices are delegated to this document — it documents the existing, already-agreed component inventory and admission boundaries from the accepted plan.

## Outcome

A person can review one or many Markdown comparisons and source patches, leave comments on files or line ranges, and copy or download one complete, contextual review for an agent. The first version is single-player: the host supplies the diffs and owns persistence. Review comments do not require authentication, a Git repository, a network connection, or an agent integration.

## Experience

The review opens with a file list, a diff surface, and a comments panel. A single file uses the same controls without a redundant navigation pane. Multiple input patches may each contain multiple files, and one session may mix those patches with Markdown comparisons. Two targets with the same path remain distinct through their target identifiers and labels.

Select a file to inspect it. Use a line's add-comment control or select a contiguous line range on one side of a diff. The composer names the file, side, and range before saving. A file-level comment is available even when there are no commentable text rows. Comments can be edited, deleted, resolved, and reopened. Deleting a new diff comment removes it from state and subsequent exports after explicit confirmation. File-level reviewed state is independent of comment resolution. Each file header has a controlled `Reviewed` checkbox; its key is target ID, snapshot identity, and file occurrence, never path alone. Any input change resets every reviewed marker for that target. Removing and later reintroducing a target also resets its reviewed markers.

Changing files, filtering the list, collapsing a file, or changing a viewer mode must not discard a partially written comment. The primary action is `Copy review`, defaulting to every saved comment across the session (including resolved and outdated). An `Unresolved only` export option is available and visibly names its scope. Export is blocked until the user saves or explicitly discards every nonempty draft.

## Data and revision contract

The host supplies an ordered list of targets with a unique stable `targetId`, display label, optional repository label, and either a Markdown original/current pair or source patch text. Optional human-readable base/head revision labels are opaque display data, never asserted to be Git commits.

Every target's content identity derives deterministically from its exact input strings plus rendering-normalization settings. Comments retain that identity at creation. Reusing a caller revision label with different input content must still invalidate old anchors. No clock, random ordering, or DOM state participates in content identity.

A saved diff comment has a stable ID, target ID, snapshot identity, file identity, body, creation/update timestamps, resolved state, and a discriminated file or line-range anchor. A line-range anchor records side (`old` or `new`), inclusive one-based line range, coordinate space, selected text, available surrounding context, and both file paths. Raw source, normalized Markdown, and existing document-text coordinates must never be mislabeled as each other. Identity includes target and file occurrence, so repeated paths in separate targets cannot collide.

When input content or normalization settings change, every saved comment on that target retains its original identity and excerpt and becomes outdated. Switching view modes or reordering targets alone does not invalidate comments. Outdated state is **latched** once an input change is observed: returning to earlier content does not silently mark an old comment current again. A removed target remains represented by captured metadata in the comments list; there is no automatic relocation, revalidation, or resolution in this version.

The host owns serializable session state through a controlled `state` prop and `onstatechange(nextState)` notification. A versioned JSON snapshot round-trips comments, review-level note, drafts, selected target, and reviewed markers without component instances or DOM coordinates. Unsupported versions, duplicate identifiers, invalid ranges, and malformed records return explicit errors and do not partially replace live state. Invalid target discriminants, duplicate IDs, or non-string content reject a supplied target-list update atomically, retain the previous valid list/state, and expose a structured validation error.

## Agent export contract

Provide pure, DOM-free Markdown and JSON exporters under an Editor package subpath (`exportDiffReviewMarkdown`, `exportDiffReviewJson` — DR-5). UI copy/download actions call the same exporters. Export does not modify comment resolution or reviewed state and does not imply that feedback was delivered or acted on. JSON contains `schemaVersion: 1`, review metadata, scope, totals, and comment records with captured anchor context without loss. Identical input and options produce byte-identical output. Timestamp values come from state; exporters never add the current time.

## Normative implementation handoff

This section resolves the specialist review findings and is part of every affected issue's acceptance criteria (DR-1 turned these into executable declarations and fixtures; DR-2 replaces those fixture functions with the real production implementation, preserving the accepted signatures and expected values).

### Public surface and contract fixtures

The new discoverable Editor component leaves are exactly `DiffReview` and `DiffReviewComments` (DR-6). State and export modules are **public functions/types, not component leaves**. Public consumer paths include `@lostgradient/editor/diff-review`, `@lostgradient/editor/diff-review/styles`, `@lostgradient/editor/diff-review-comments`, `@lostgradient/editor/diff-review-comments/styles`, **`@lostgradient/editor/diff-review-state`** (this issue), and the existing `@lostgradient/editor/export`. `createDiffReviewState`, `reduceDiffReviewState`, `serializeDiffReviewState`, and `restoreDiffReviewState` are the public pure functions under `diff-review-state`. `reduceDiffReviewState` returns the next immutable state or an error; the host synchronously accepts it before another action. Components never mutate the supplied state. Pure modules remain plain `.ts`, usable in SSR without DOM globals or module-level shared state.

### Identity, schema, and validation

Content identity is lowercase SHA-256 hex of UTF-8 `JSON.stringify` of the fixed tuple `['diff-review-v1', 'source', patch]` or `['diff-review-v1', 'markdown', original, current, normalizeInputs]`. `normalizeInputs` is the resolved boolean default from the viewer. Preserve input CRLF/LF, whitespace, Unicode, and lone surrogates through JSON encoding; do not normalize strings before hashing. Label, path, revision labels, target ordering, display mode, and `maxLines` are **not** hash inputs. Use the portable synchronous `sha256` subpath from an explicit Editor runtime dependency on `@noble/hashes/sha2.js` — this issue adds and locks that package dependency and tests browser/SSR use. Do not write a cryptographic implementation or depend on an undeclared transitive package.

The version-1 state contains ordered target descriptors with IDs and last observed snapshot IDs, comments, drafts, review note, selected target/file, and reviewed markers. Full input strings are supplied separately by the host. Captured comment/draft context contains target kind and label, repository/revision labels when supplied, old/new paths or null, zero-based file occurrence, original snapshot ID, coordinate/mapping provenance, selected text, and available before/after context (at most three same-side context lines before and after within the known hunk/body — never fetched). File anchors have no line range. Range anchors additionally require nonnegative hunk occurrence, side, positive inclusive start/end, coordinate space, and selected text. These fields and the body/status/timestamps are normative serialized data. Display counts, formatted relative dates, focus nodes, and derived visibility are never persisted.

The host may supply an ID factory and clock to action functions; defaults use `crypto.randomUUID()` and canonical UTC ISO timestamps at the user action boundary only. Neither defaults nor factories run during rendering, validation, hashing, or export. IDs are nonempty strings unique within their domain (targets, diff comments, drafts); collisions return `duplicate-id`, without retrying. The clock must produce a valid canonical ISO timestamp. Creation sets both timestamps; updates use the later of creation/previous update and the supplied clock, so **clock rollback cannot reverse record time**. Restore rejects noncanonical or inverted timestamps. Export IDs are domain-tagged tuples serialized as JSON strings (`['diff', commentId]`, `['document', targetId, threadId]`) so user IDs containing separators cannot collide.

Every operation returns `{ok: true, value}` or `{ok: false, error: {code, path, message}}`. The finite codes are `unsupported-version`, `invalid-target`, `duplicate-id`, `invalid-record`, `invalid-anchor`, `invalid-timestamp`, `missing-context`, `drafts-pending`, and `readonly`. Validation returns the first error in schema-field order and then array order, with a JSON Pointer path. Unknown object keys are rejected in versioned snapshots/export inputs. Schema-invalid initial state shows an error and does not expose an empty-success session; later invalid updates retain the last valid state. Restore and target replacement validate completely before any state change or notification. A draft or comment referencing an absent current target is valid only with complete captured target/file/anchor context. Malformed records fail export atomically with no partial string/download; missing live target content alone is not an error.

Reviewed markers survive target/file-list reorder and changes to labels, viewer mode, or line limit. Target removal deletes its markers; reintroduction starts unreviewed even with identical content. Any content/normalization change resets all markers for that target and latches every older comment/draft outdated.

### Drafts, modes, and restore

Multiple drafts are allowed, one per draft ID, each retaining its captured anchor and original snapshot. Whitespace-only drafts cannot be saved and do not block export; retain their text in state. A draft is nonempty for blocking purposes exactly when `body.trim().length > 0`. Saving a draft whose target changed or disappeared creates an explicitly outdated saved comment using captured context. All export scopes remain blocked until each nonempty draft is saved or explicitly discarded.

Restore matches supplied targets by target ID, never path. Reorder keeps matching selection/drafts/comments. Missing targets retain complete captured drafts/comments and remove reviewed markers. If selected target/file is missing, select the first available target/file, or null when none exists. Present targets with different content invalidate restored old anchors immediately. Matching content preserves the stored outdated latch. **This behavior is identical for remount and an atomic live target-list update** — this module's `restoreDiffReviewState` shares its reconciliation logic directly with the live `set-targets` action rather than re-implementing it.

`readonly` defaults false. In read-only mode, navigation, filters, viewing comments, and valid exports remain available. Create/edit/delete/resolve/reopen, review-note editing, Reviewed, draft save/discard, and range-creation controls are disabled; underlying action handlers also return `readonly`. `set-targets` (a host-driven content update, not a user mutation) is not blocked by readonly.

## Component inventory and admission boundary (existing, documented here)

This module (`diff-review-state`) is a pure state/data module, not a component leaf, so it carries no generated component-artifact/admission record of its own; `components/cinder`'s `generate-component-artifacts.ts` script (invoked as `components:generate`/`components:check`) covers Editor's discoverable _component_ leaves (`DiffViewer`, `ReviewEditor`, `MarkdownEditor`, and later `DiffReview`/`DiffReviewComments`) via prop-convention inspection; it does not enumerate non-component library exports like this one. This module's own admission gate is its focused test suite (`DiffReview state`), `typecheck`, and its registration in `scripts/mirror/package-surface.json` and `src/index.ts`, following the existing `./export` and `./session` subpath precedent.

## Agent export format (DR-5, `COR-513`)

`exportDiffReviewMarkdown(state, options?)` and `exportDiffReviewJson(state, options?)` (both `DiffReviewResult<string>`) live under `components/editor/src/lib/export/` and are public through the **existing** `@lostgradient/editor/export` subpath — no new subpath registration was needed. Both functions build one internal `DiffReviewExportModel` (validated state, scope-filtered comments, fully ordered records, and totals) and render it into their respective format, which is why the two formats agree on IDs, bodies, location, and state by construction rather than by convention.

- **Options:** `scope` (`'all'` default, or `'unresolved'`, which excludes resolved diff comments but still includes every existing-document thread — those have no resolved state and are always treated as open), `reviewTitle` (default `'Review feedback'`), and `documentThreads` — a dedicated, minimal projection of existing (pre-diff-review) document-anchored threads (`{ targetId, threadId, createdAt, anchor, messages: [{ id, body, createdAt, deletedAt? }] }`), separate from `comments/types.ts`'s `PersistedThread`. `anchor` is `{ kind: 'document' }` or `{ kind: 'document-text', quote, prefix, suffix }` — the contract's own "explicit `document-text` or document-level anchor variant," mirroring the TextQuoteSelector fields `shared/anchor-types.ts` already anchors a live thread with. This issue owns the full shape; `DR-7` supplies real values for it without extending the schema (its own contract text: "does not defer or extend that schema").
- **Validation order (atomic, no partial output on any failure):** the state is validated with the existing `validateSerializedDiffReviewState` (reused, not reimplemented) against its own live target IDs, then `documentThreads` is structurally validated (including each thread's `anchor` discriminant), then `ensureDiffReviewNoPendingDrafts` blocks export on any nonempty draft. Errors use the same finite `DiffReviewErrorCode` set and `{code, path, message}` shape as the rest of `diff-review-state`.
- **Ordering:** current targets in `state.targets` order, then comments on missing (removed) targets grouped by captured target ID (code-unit string order); within a target, file occurrence ascending; within a file, file-level comments before range comments, then by side, then by ascending line range, then creation timestamp, then the namespaced export ID as the final tie breaker. Existing-document thread records are appended in their own trailing section after every diff record, ordered by thread creation time then export ID.
- **IDs:** each record carries a domain-tagged `exportId` — `["diff", commentId]` for a diff comment, `["document", targetId, threadId]` for an existing thread — serialized with `JSON.stringify` so a collision between the two domains' raw IDs can never occur.
- **Without loss:** a diff record's `anchor` (for a range) carries `hunkOccurrence`, `selectedText`, and the full untrimmed `contextBefore`/`contextAfter` captured by the state, plus `targetKind` — the complete captured anchor context, not only the two-line-trimmed excerpt Markdown quotes. The Markdown renderer derives its own quoted excerpt from these same fields rather than the model carrying two representations of the same text that could drift apart.
- **Literal blocks:** the quoted source excerpt, the feedback body, the review note, and an existing-document `document-text` thread's quoted text are each wrapped in a backtick fence of length `max(3, longest backtick run in the content + 1)`, with no info string, and structural newlines that never trim or merge with the content's own leading/trailing newlines (a body ending in `\n` renders as a literal blank line before the closing fence). `reviewTitle` and every target/comment ID, label, and path render as trusted, unfenced heading/field text — only the excerpts, the bodies, and the note are user content the format defends against; a label or path containing a newline or a Markdown heading marker is out of scope for this issue's malicious-content fixture, which targets fences and HTML specifically.
- **Coordinates:** a range record names its `side` and `coordinateSpace` (`raw-source` or `normalized-markdown`) and its exact one-based line or inclusive range; a `normalized-markdown` comment's `rawMapping` is always `{status: 'unavailable', reason: 'normalization'}` and no raw coordinate is ever synthesized for it, even though `source-line-map.ts`'s interpolating map could produce one — see `diff-review-export-interpolation.test.ts`, which drives the real map on an input where a normalized line corresponds to no source line at all, to prove the omission is deliberate rather than untested. An existing-document thread names its own anchor kind (`document` or `document-text`) via a `Location:` line, distinct from a diff record's file/range location.
- **JSON:** `schemaVersion: 1`, two-space indentation, exactly one trailing newline. `diff-review-export-schema.ts` exports the versioned JSON Schema; `diff-review-export-json.test.ts` validates fixtures against it with `ajv`, and `diff-review-export-golden.test.ts` validates every checked-in golden JSON against the same schema.
- **Golden fixtures and accepted cases:** checked in under `components/editor/src/lib/export/__fixtures__/diff-review/` (`.md` and `.json` pairs), asserted byte-for-byte by `diff-review-export-golden.test.ts` (run twice, also covering "identical input and options produce byte-identical output"):

  | Case | Fixture | Test |
  | --- | --- | --- |
  | Two source targets sharing one path; old/new ranges; resolved and outdated comments; a file comment | `two-source-targets.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-ordering.test.ts` |
  | Markdown target: normalized (`rawMapping` unavailable) and raw (normalization disabled, `rawMapping` exact) coordinates; a review note | `markdown-targets.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-markdown.test.ts` |
  | Empty review (no targets, no comments) | `empty-review.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-validation.test.ts` |
  | Malicious-looking fenced text and HTML in the quoted source, the feedback body, and the review note | `malicious-content.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-markdown.test.ts` |
  | Empty quoted line and a body with a trailing newline | `empty-and-trailing-newline.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-markdown.test.ts` |
  | Explicit `scope: 'unresolved'` export | `unresolved-only.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-ordering.test.ts` |
  | Existing document threads: a deleted initial message with surviving replies (`document` anchor), a fully deleted thread (dropped entirely), and an ordinary multi-message thread (`document-text` anchor with quote/prefix/suffix) | `with-document-threads.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-document-threads.test.ts`, `diff-review-export-json.test.ts` |
  | A target commented on, then removed via the real `reduceDiffReviewState`/`set-targets` reducer, latching its comment outdated | `removed-target.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-ordering.test.ts` |
  | A normalized-Markdown anchor at a line the real, production `source-line-map.ts` genuinely interpolates — proof that omitting a raw coordinate is deliberate, not untested | `interpolating-source-line-map.{md,json}` | `diff-review-export-golden.test.ts`, `diff-review-export-interpolation.test.ts` |

- **Not in scope here:** the download `Blob`/filename helpers (`review.md` / `review.json`, their MIME types) belong to `DR-6`'s UI actions; this issue only asserts the pure string output the download actions will wrap.

## Suite prefix and verification

New tests for `diff-review-state` use the `DiffReview state` suite prefix; new tests for the DR-5 exporters use the `DiffReview export` suite prefix. Verification:

```bash
bun run --filter=@lostgradient/editor test --test-name-pattern 'DiffReview state'
bun run --filter=@lostgradient/editor test --test-name-pattern 'DiffReview export'
bun run --filter=@lostgradient/editor typecheck
bunx prettier --check components/editor/documentation/diff-review-contract.md
```

Publication of the Editor package (including this new subpath) is DR-9 and happens through the separate public mirror repositories; this repository does not run Changesets, CI, or npm publication (see `AGENTS.md`).
