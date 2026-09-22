# MarkdownEditor · accessibility

## Pattern

MarkdownEditor packages a higher-level workflow. Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: Rich Markdown editing surface bundling a Milkdown-powered ProseMirror editor, toolbar, and mark or block introspection helpers.

## Use when

- Composing or editing Markdown documents and wanting the bundled toolbar, link-aware selection, and source or WYSIWYG mode toggle.
- Building writing surfaces that need an editor handle for programmatic mark or block manipulation as part of the heavyweight suite.

## Avoid when

- Authoring a simple plain-text note — a textarea is dramatically lighter than the Milkdown bundle.
- The surface needs inline review threads on top of the editor — use review-editor for that composition.

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

The **More formatting** button appears only when the toolbar is too narrow to show every command group inline; at widths where everything fits, there is no overflow trigger and no hidden commands. When it is present, it opens a priority-plus Popover containing whichever groups did not fit. Opening it moves focus to the first enabled formatting action. `Tab` and `Shift+Tab` follow the panel's native button order; each button's existing shortcut remains available while the editor is focused. `Escape` closes the panel and restores focus to More formatting. Activating Insert Link first closes the formatting panel, then opens the link dialog from the same visual anchor so only one floating focus scope is active. The panel is named **More formatting**, its command groups retain their accessible labels, and toggle buttons expose their pressed state without an additional live announcement.

Which commands sit inline versus in the overflow panel is width-driven, but it is deliberately **frozen while focus is inside a group or on the More formatting trigger**. A resize that would otherwise move the focused group across that boundary — or empty the overflow set entirely, unmounting the trigger — is held until focus moves on. Without this, a window resize or a container reflow silently relocates the control under the user's cursor, or drops keyboard focus to `<body>`. Two consequences worth knowing when reviewing: the trigger can remain present at a width where everything would otherwise fit, and a command can remain in the panel for the same reason. Both resolve as soon as focus leaves.

Keep focus indicators visible. If you wrap or restyle MarkdownEditor, verify the focused element remains visually apparent in default and forced-colors modes.

**Resizing while a formatting group is focused never relocates it.** The priority-plus split re-evaluates continuously as the toolbar is resized, and a resize can, in principle, land exactly when focus is inside one of the four movable groups (Text formatting, Links, Lists, Block operations). Relocating a group across a resize means unmounting its buttons at one render site (the inline row or the popover panel) and mounting new ones at the other — Svelte does not move DOM across `{#if}` branches, it destroys and recreates — so an unguarded move drops focus to `<body>`, a keyboard trap-adjacent failure.

The chosen behavior: whichever side a group is on at the moment it receives focus — inline or inside the popover — is frozen there until focus leaves that group, regardless of what the fit calculation recomputes to while focus remains. This is symmetric: a focused inline group is kept inline even if a narrowing resize says it should overflow, and a focused _popover_ group is kept in the popover even if a widening resize says it would now fit inline (moving it back inline while focused would unmount-and-remount it out from under the user exactly the same way). Focus moving within the same group (e.g. Bold → Italic) does not release the freeze; focus moving to a different group, to a non-movable control (History, Block type, the popover trigger), or out of the toolbar entirely does. The alternative considered — always moving focus to the "More formatting" trigger the instant a focused group would relocate — was rejected because it does the same "yank focus while the user is mid-interaction" thing, just to a different, less predictable place; freezing the group in place is the less surprising outcome and keeps focus exactly where the user left it. The tradeoff: the frozen group's own width is not released from the fit budget it would otherwise reclaim (or is not squeezed out of a budget it would otherwise exceed) until focus moves on, so the toolbar can briefly be a little more (or less) full than the ideal split — the same `overflow-x: auto` fallback that covers pre-measurement windows absorbs that overage. The "More formatting" popover itself will not auto-close while it holds a frozen, currently-focused group, even if every other group would otherwise let it close.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When MarkdownEditor accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

## Verification

- Render MarkdownEditor in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

Accessibility review outcome: the priority-plus overflow is accepted because its trigger is named, opening enters the portaled command surface, Escape restores the trigger, commands retain native keyboard order and state, and the nested link flow closes the first Popover before opening the dialog.

## Raw mode's code-variant adoption (COR-485)

Raw Markdown mode composes the base `Textarea` component with `variant="code"` (`markdown-editor.svelte`) instead of a bare `<textarea>` with locally hardcoded metrics. Its neighbor for this comparison is a standalone `Textarea variant="code"` instance (`components/cinder/src/components/textarea/textarea.svelte`, `textarea.css`) — since raw mode's control literally is that component, the shared metric declarations (`font-family`, `font-size`, `line-height`, `tab-size`) and surface declarations (`background`, `color`) are the same CSS rule by selector identity (`.cinder-textarea`, `.cinder-textarea[data-cinder-variant='code']`), not merely a matching value that could drift.

Verified against source revision `abc84f19d88461fe1bfd013f004c6dad928b7ab2`, `components/editor/src/lib/components/markdown-editor/markdown-editor.svelte`, against the `markdown-editor` fixture page (`scripts/browser-fixtures/src/fixtures/markdown-editor.svelte`, `#agent-prompt` mount, which defaults to raw mode) served locally at `/page/markdown-editor`. Screenshots and the capture script (`capture-a11y.ts`) that produced the computed-style values below are attached to COR-485 (Uploaded evidence, this ticket) as `dark-source-unfocused.png`, `dark-source-focused.png`, `dark-source-readonly.png`, `light-source-unfocused.png`, `light-source-focused.png`, `light-source-readonly.png`; the same six files and the capture script also live at `/private/tmp/claude-501/-Users-stevekinney--agent-worktrees-claude-corvidae-code-variant-markdown-editor-a1262d/02cb9e1e-86f8-4791-b9e4-2ef97dcf7aa2/scratchpad/cor-485-a11y/` on the machine that generated them (a session scratchpad — not durable; the Linear attachments are the record of reference). Capture method: Playwright, real trusted click for the focused state — a script-driven `.focus()` in a document without OS window focus produces an unreliable `:focus-visible` match and must not be used for this kind of verification.

Computed values (`getComputedStyle`, unfocused unless noted). "Neighbor" is a bare `<textarea class="cinder-_input-frame cinder-textarea" data-cinder-variant="code">` element injected into the same served stylesheet cascade — the literal class/attribute contract Textarea's own compiled output uses, not a value copied from source:

|  | Raw mode, light | Neighbor, light | Raw mode, dark | Neighbor, dark |
| --- | --- | --- | --- | --- |
| `background-color` | `oklch(1 0 255)` | `oklch(1 0 255)` | `oklch(0.28 0.045 245)` | `oklch(0.28 0.045 245)` |
| `color` | `oklch(0.2 0.018 245)` | `oklch(0.2 0.018 245)` | `oklch(0.92 0.02 245)` | `oklch(0.92 0.02 245)` |
| `font-family` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | same | same | same |
| `font-size` | `13px` | `13px` | same | same |
| `line-height` | `19.5px` | `19.5px` | same | same |
| `tab-size` | `2` | `2` | same | same |

Every metric and surface value is byte-identical between raw mode and the neighbor, in both themes — not merely close, because both resolve through the exact same unscoped `.cinder-textarea` / `.cinder-textarea[data-cinder-variant='code']` rules in `textarea.css` (`--cinder-font-mono`, `--cinder-text-sm`, `--cinder-leading-normal`, `--cinder-type-tab-size`, `--cinder-surface-raised`, `--cinder-text-default`).

Three further values are recorded here because they're the places raw mode's computed value differs in _shape_ from a bare standalone `Textarea variant="code"`, and each is a deliberate, reviewed embedding difference, not a gap:

|  | Light | Dark |
| --- | --- | --- |
| `border` (unfocused) | `0px none` | `0px none` |
| `box-shadow` (focused, real click, `:focus-visible` true) | `oklch(0.55 0.16 270) 0px 0px 0px 2px inset` | `oklch(0.7 0.14 270) 0px 0px 0px 2px inset` |
| `background-color` (`[readonly]`) | `oklch(1 0 255)` — unchanged from editable | `oklch(0.28 0.045 245)` — unchanged from editable |

- **Border and radius are `none`, not Textarea's default 1px bordered box.** The editor's own `.markdown-editor-wrapper` owns a single outer border and radius for the whole card (toolbar + content); a bordered child control inside it would double the border. `markdown-editor.svelte`'s `<style>` block strips it back to flush with an unlayered override (`:global(textarea.markdown-editor.source-mode) { border: none; border-radius: 0; }`) — unlayered author CSS always outranks Cinder's own `@layer cinder.components` declarations regardless of selector specificity, so this override is stable against any future `.cinder-textarea`/`.cinder-_input-frame` change.
- **The focus ring is an inset single ring tied to `--_cinder-markdown-editor-surface-ring`, not Textarea's default outer two-stop ring (`--_cinder-focus-ring-shadow`).** Textarea's own `variant="code"` focus treatment is an _outer_ ring with `border-color: transparent`. Embedded here, that would double up visually with `.markdown-editor-wrapper:focus-within`'s own border turning accent-colored. Raw mode instead shares the exact rule WYSIWYG mode already uses for the same reason (`.markdown-editor.surface:focus-visible`) — same box-shadow recipe, same ring color token, same forced-colors fallback — so both modes present one consistent ring shape when switching between them.
- **`[readonly]` carries no special treatment**, because textarea.css doesn't define one — the surface stays at its ordinary `background`/`color`. This matches (not merely resembles) the WYSIWYG surface's own explicit `[data-readonly] { background: var(--cinder-surface-raised) }`, confirmed by direct measurement above rather than assumed from the absence of a rule.

Padding (`--cinder-space-4`, larger than Textarea's own field default of `--cinder-space-2 --cinder-space-3`) is unchanged from raw mode's pre-existing value and is not part of this ticket's token contract (font/background/focus/tab-size only) — kept as-is to match the surrounding card's proportions and the WYSIWYG surface's own `padding: var(--cinder-space-5)`.

Reviewer outcome: no native `rgb(59,59,59)` or other browser-default UA background is reachable in either theme, focused or readonly, editable or read-only — confirmed by both the computed-value table above and the visual captures. `markdown-editor.code-variant.test.ts` is new and pins the composed contract (code-variant class/attribute, value binding, `onchange`, `readonly`, accessible name/description, id uniqueness) so a future regression back to a bare `<textarea>` fails a test, not just a screenshot diff. `markdown-editor.toolbar-layout.test.ts` (unchanged) and `markdown-editor-toolbar.playwright.ts` (unchanged) both re-ran green against the composed control's new DOM shape (Textarea's `FormFieldFrame` wrapper is now a Svelte-scope boundary, requiring `:global()` on every selector in `markdown-editor.svelte` that reaches into it); svelte-check (`--fail-on-warnings`) confirms no unused-selector regression from that scope boundary shift.

Related components: `review-editor`, `code-block`, `textarea`.

## LinkPopover: nonmodal semantics and density (COR-463)

The Insert Link / Edit Link panel (`editor-toolbar/link-popover.svelte`) is an anchored toolbar panel, the same nonmodal pattern ReviewEditor's ThreadPopover and Cinder's own Popover already use — not a page-blocking modal. It declares `role="dialog"` with a visible-title `aria-labelledby`, omits `aria-modal`, and attaches no focus trap: the surrounding editor and page stay reachable while it is open, exactly as their markup claims.

### Keyboard matrix

| Key / action | Behavior | Source review or AT testing |
| --- | --- | --- |
| `Tab` from the last control (Insert/Update, or Cancel when nothing else is enabled) | Leaves the popover in normal document order (no wrap-around, no interception); does not close it | Source review + `link-popover.test.ts` (dispatches a real `Tab` `KeyboardEvent`, asserts `preventDefault` was not called and focus was not redirected) |
| `Shift+Tab` from the first control (the URL input) | Leaves the popover in normal document order toward the trigger; does not close it | Source review + `link-popover.test.ts` |
| `Escape` | Closes the popover (`onclose`); the parent restores focus to the editor | Source review + `link-popover.test.ts`, `markdown-editor.test.ts` |
| Initial open (anchored or standalone) | Focus moves to the URL input once anchored positioning is ready (or immediately in standalone rendering) | Source review + `link-popover.test.ts` (happy-dom) + `markdown-editor-toolbar.playwright.ts` (real Chromium, all 5 popup cases) |
| Outside click (a different toolbar control, the document, anywhere outside the panel) | Closes the popover via a separate path (`onOutsideDismiss`) that does **not** call the parent's editor-focus restoration, so the click's own target keeps focus | Source review + `link-popover.test.ts` (asserts `onOutsideDismiss`, not `onclose`, fires, and the clicked control keeps focus) |
| Cancel / Close button / successful Insert / Update / Remove | Closes the popover via `onclose`; the parent restores focus to the editor (unchanged) | Source review + `markdown-editor.test.ts` (asserts each handler retains its `editorState.focus()` call) |
| `Enter` while the form is valid | Submits (same as clicking Insert/Update) | Source review (pre-existing, unchanged by COR-463) |

No assistive-technology software (VoiceOver, NVDA, JAWS) was run against this panel for COR-463; every row above is source review plus the automated tests named, not observed AT behavior. A future AT pass should confirm the dialog's name is announced on open and that leaving via Tab reads as ordinary document navigation, not a trap escape.

### Density

Composes the shared floating-surface treatment (`components/cinder/src/styles/components/_floating-surface.css`'s `cinder-_floating-surface` class — the same class Cinder's own Popover and ChatNavigationRail's preview surface use) for the border, medium radius, raised surface, and elevation shadow, with the wrapper's own padding zeroed so the header/content/footer bands own their padding once. Header and footer are each ≤40px on a fine pointer (6px block padding around a 28px row — the sm Button height and the Close button share that 28px). Title and action icons are the existing 16px (`cinder-icon-sm`) utility, unchanged. Content padding and gap are ≤12px (`--cinder-space-3`). The Close button is 28px on a fine pointer, bumped to the 44px WCAG 2.2 AA touch target under `@media (pointer: coarse)` — the same pointer-aware convention `number-input`'s stepper buttons use — rather than enlarging every desktop icon.

Verified at 320×800 and 1280×720, light and dark, across the five popup cases (insert with selected text, insert without selection, edit an existing link, invalid URL, disabled submit with missing required data) in `scripts/browser-fixtures/tests/markdown-editor-toolbar.playwright.ts`: no horizontal viewport overflow, header/footer height, icon size, close-button size, content padding/gap, and that the initial focus and Close control are reachable, for every case.
