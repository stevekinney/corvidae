# Theme builder accessibility and design review record

This record belongs to CIN-573/TB03. It is intentionally a review form plus a testable artifact checklist. Planning approval from the [R4 approved specification](https://linear.app/lost-gradient/document/theme-builder-approved-specification-and-issue-graph-e620a80331ee) and [R5 amendment](https://linear.app/lost-gradient/document/theme-builder-open-source-research-and-planning-amendment-e2cff94ed833) does not substitute for the human design and accessibility approvals required by the execution contract.

## Artifact identity

| Field | Value |
| --- | --- |
| Issue | CIN-573 / TB03 |
| Artifact | `docs/theme-builder.md` and this review record |
| Branch | steve/open-decisions-2026-09-19 (corvidae; originally steve/cinder-delivery-theme-design in cinder) |
| Contract inputs | CIN-573 execution contract; [R4 approved specification](https://linear.app/lost-gradient/document/theme-builder-approved-specification-and-issue-graph-e620a80331ee); [R5 amendment](https://linear.app/lost-gradient/document/theme-builder-open-source-research-and-planning-amendment-e2cff94ed833) |
| Artifact commit | Branch `steve/open-decisions-2026-09-19` in corvidae; the commit SHA is recorded on COR-242 |
| Design artifact SHA-256 | `48624c0d109349a334a8b77c01a02bcb377f7df7e6fb9d7660f0c2d55fb8b3b7` (`docs/theme-builder.md`) |
| Review status | Pending human design and accessibility review |

Do not complete a pending field by inference. The final record must identify the exact commit or content digest that Steve reviewed.

## Required human approvals

### Steve's design approval

- Reviewer: **Pending Steve Kinney**
- Date: **Pending**
- Exact artifact revision: **Pending**
- Decision: **Pending**
- Findings: **Pending**

Steve must review the four annotated layouts, state matrix, Cinder primitive mapping, proposal/import flows, and R5 provenance/dependent navigation additions. Approval means the interaction and layout are accepted for implementation at the exact artifact revision.

### Accessibility practitioner review

- Reviewer: **Pending Steve Kinney or named human practitioner**
- Practitioner name and qualification: **Pending**
- Date: **Pending**
- Platform, browser, and assistive technology versions: **Pending**
- Exact artifact revision: **Pending**
- Decision: **Pending**
- Findings: **Pending**

The named human reviews whether the artifact specifies the keyboard, VoiceOver, zoom/reflow, focus, and screen-reader behavior completely and accessibly. An agent cannot supply this approval. Live runtime execution of these scenarios belongs to CIN-582 after implementation; this record must not claim that those tests have already run.

## Human artifact review checklist

### Layout and responsive behavior

- [ ] 1440px shell keeps navigation, editor, preview, checks, status, and export visible without accidental scroll regions.
- [ ] 768px layout uses the 176px rail, stacked catalogue label/value pairs, and selected editor in the flexible main region; preview/checks occupy the full-width row below.
- [ ] 390px layout uses Edit, Preview, and Checks tabs while retaining selection, context, draft status, and export.
- [ ] 320px layout has no horizontal page overflow, clipped focus ring, or unusable action target.
- [ ] Mobile catalogue uses stacked friendly-name/value rows with disclosure details rather than the desktop six-column table.
- [ ] Provenance and proposal before/after rows stack without side-by-side comparison on narrow screens.

### Keyboard and focus

- [ ] Skip link reaches builder heading and does not skip the first meaningful landmark.
- [ ] Toolbar, category navigation, catalogue rows, editor controls, preview controls, checks, and status have predictable Tab order.
- [ ] Catalogue selection supports row navigation, Home/End, Enter, and typeahead/search without losing selected token.
- [ ] Tabs use documented arrow/Home/End behavior and preserve selection across panels.
- [ ] Every popover, disclosure, and dialog closes with Escape at the correct nesting level.
- [ ] `Modal`, `ConfirmDialog`, and `AlertDialog` usage traps focus, exposes title and description, and restores focus to the invoking trigger.
- [ ] Source/dependencies navigation can follow a dependent and return to originating token, context, and trigger focus.
- [ ] Native text undo wins while an input is focused; builder undo does not erase text unexpectedly.
- [ ] Slider keyboard changes commit as one transaction and do not announce every intermediate frame.
- [ ] Focus is visible and unobscured at all four viewport widths.

### Forms, errors, and destructive actions

- [ ] Every field has associated label, stable id, description where needed, and path-addressed error.
- [ ] Invalid draft remains visible, receives aria-invalid, and does not replace last-valid preview.
- [ ] Rename rejects empty, overlong, and case-insensitive duplicate names without changing current name.
- [ ] Delete names theme in dialog, moves it to recoverable trash, and makes Restore available.
- [ ] Permanent delete requires explicit confirmation and cannot be triggered by Escape/default action.
- [ ] Storage failure preserves in-memory edits and exposes download recovery.
- [ ] Storage conflict offers Reload latest and Save as copy without silent overwrite.
- [ ] Import failure leaves draft and last-valid preview unchanged and allows unchanged download.
- [ ] Unsupported proposals distinguish Cancel, Apply, and download-only recovery.

### Screen reader and announcement behavior

- [ ] The artifact specifies how route entry announces or exposes `Theme builder` and primary landmarks.
- [ ] Selection, context, draft revision, and stale-preview status do not rely on color.
- [ ] The artifact specifies that committed edits announce path and value once while slider frames stay quiet.
- [ ] The artifact specifies completed-check announcements with counts and severity categories.
- [ ] The artifact specifies import announcements for supported, unsupported, or invalid disposition and recovery.
- [ ] Alias/recipe disclosures expose authored, resolved, source, context, dependents, and representation changes.
- [ ] Empty/no-dependent, unknown-metadata, source-only, stale, and invalid/cyclic states have meaningful text.
- [ ] Callout meaning is conveyed by title/text/icon as well as color.
- [ ] Tooltip text supplements accessible name and never carries the only error or state.

### Context, provenance, and interoperability

- [ ] Light/dark and default/reduced/forced-reduced-motion contexts are named and retained through navigation.
- [ ] Provenance rows identify source labels as explanations, not unexplained compatibility badges.
- [ ] Two-hop aliases and overridden contexts list affected dependents once per concrete context.
- [ ] Stale provenance/proposal results identify evaluated revision and cannot be applied.
- [ ] Supported Cinder envelope, supported DTCG, recognized unsupported dialect, and invalid input are distinct.
- [ ] Unknown source URL/version/license metadata is labeled unverified and never fetched or inferred.
- [ ] Imported source preserves root, extends, ref, descriptions, deprecation, and unknown extensions.
- [ ] Inherited strokeStyle preserves source while malformed values fail with original paths.

## Review scenarios and evidence

The reviewer should record the artifact evidence—a section/table reference and a short finding—for each scenario. A checked box without evidence is not approval. Runtime results, browser versions, screenshots, and VoiceOver execution are planned evidence for CIN-582, not claims made by this CIN-573 document.

| Scenario | Expected evidence | Result |
| --- | --- | --- |
| Start at 1440px | Landmarks, selected foundation, saved status, preview and checks visible | Pending |
| Dirty edit and invalid draft | Input text remains, error relationship, last-valid preview label | Pending |
| Alias/recipe and two-hop provenance | Follow dependent, context retained, Back restores trigger focus | Pending |
| Checks and fix | Error to proposal to Apply/download outcome; one announcement | Pending |
| Spacing proposal | Before/after paths, target scope, Cancel/Apply, post-apply check failure | Pending |
| Import success | Envelope and DTCG preflight details; Apply leaves source lossless | Pending |
| Import unsupported/invalid | Four-way disposition, unchanged draft, unchanged download | Pending |
| Storage conflict/failure | Reload or Save as copy; in-memory recovery download | Pending |
| Rename/trash/permanent delete | Conflict, recoverable trash, explicit permanent confirmation | Pending |
| 768px reflow | No clipped controls; catalogue/editor relationship clear | Pending |
| 390px reflow | Tabs retain state; stacked catalogue and provenance | Pending |
| 320px reflow | No page overflow; focus and action targets usable | Pending |
| Keyboard-only specification | Full matrix is defined without pointer-only behavior | Pending |
| VoiceOver specification | Announcements, names/roles/values, errors, context are defined | Pending |
| Zoom and text resize specification | Reflow and focus requirements are defined | Pending |

## CIN-582 runtime handoff

After implementation, CIN-582 owns the actual keyboard-only, VoiceOver, browser, zoom/text-resize, 320px reflow, focus-obscuring, and performance runs. Its manual record must include platform and browser versions, assistive technology version, screenshots or traces, and findings against the exact implementation revision. CIN-573 supplies the scenarios and expected outcomes; it does not pretend that the runtime exists or that those runs passed.

## Findings and disposition

| ID | Finding | Severity | Owner | Disposition | Verified revision |
| --- | --- | --- | --- | --- | --- |
| — | No findings recorded yet; human review is pending. | — | — | Pending | — |

Acceptance requires zero unresolved findings. If a finding changes the interaction model, public component boundary, import contract, or review scenario, revise the scoped artifact before implementation proceeds.

## Sign-off

The following lines are intentionally blank until named humans complete their reviews:

    Design approval: Pending Steve Kinney / date / exact artifact revision
    Accessibility approval: Pending named human practitioner / date / exact artifact revision
    Remaining findings: Pending human review; required value is zero
