# ReviewEditor · accessibility

## Pattern

ReviewEditor packages a higher-level workflow. Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: Markdown editor extended with inline review threads, anchored comments, and collaborative annotation state.

## Use when

- Building a document review experience that needs both a Markdown editor and anchored comment threads in one bundled surface.
- Threading reviewer commentary against specific selections inside a long-form document.

## Avoid when

- Plain authoring with no review threads — markdown-editor is the lighter primitive.
- Reviewing diffs between two documents rather than annotating one — use diff-viewer instead.

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

Keep focus indicators visible. If you wrap or restyle ReviewEditor, verify the focused element remains visually apparent in default and forced-colors modes.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When ReviewEditor accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

## Verification

- Render ReviewEditor in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

## Verification performed this session

- **2026-09-24 (COR-511, commit `46de156b`):** the diff-comments integration (create an old-side deletion comment in the diff tab, switch to the editor tab and back; the merged document/diff comments list; cross-tab navigation focus; cancel/discard of a pending draft into the Unsaved-drafts inventory; a disabled composer while read-only) is exercised end-to-end by `review-editor-diff-comments.playwright.ts` (Chromium via Playwright). This session added no new browser coverage to ReviewEditor directly, and it has no dedicated theme, 320px-layout, or automated-axe browser test of its own yet.
- **Human acceptance: not performed by any human.** The ratified contract (SHA-256 `ac837e3a…`) reserves DR-8 design/accessibility acceptance for Steve Kinney, covering "ReviewEditor integration"; no agent may supply it. The COR-511 orchestrating session reports Steve waived this gate on 2026-09-23 ("Nothing needs my sign off"); Linear comment `a5463ac9-c4d0-455b-ba01-d30c3fcfdb9a` on COR-511 records the same. This record relies on that report and does not independently verify it — no contract amendment was filed. No VoiceOver or other manual screen-reader pass was run against this component in any session.

Related components: `markdown-editor`.
