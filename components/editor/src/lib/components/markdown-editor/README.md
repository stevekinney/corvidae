# MarkdownEditor

Rich Markdown editing surface bundling a Milkdown-powered ProseMirror editor, toolbar, and mark or block introspection helpers.

## Usage

```svelte
<script lang="ts">
  import { MarkdownEditor } from '@lostgradient/editor';
</script>
```

## Workspace dependencies

Declare `"@lostgradient/editor": "workspace:*"` in the consuming workspace and run `bun install --frozen-lockfile` from the Corvidae root. The Editor workspace owns its Milkdown, ProseMirror, Markdown pipeline, and Cinder dependencies. Consumers import `MarkdownEditor` through `@lostgradient/editor`; they do not install the internal packages from a registry or duplicate the editor's dependency list.

## Guidance

### Use When

- Composing or editing Markdown documents and wanting the bundled toolbar, link-aware selection, and source or WYSIWYG mode toggle.
- Building writing surfaces that need an editor handle for programmatic mark or block manipulation as part of the heavyweight suite.

### Avoid When

- Authoring a simple plain-text note — a textarea is dramatically lighter than the Milkdown bundle.
- The surface needs inline review threads on top of the editor — use review-editor for that composition.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional CSS classes |
| `id` | `string` | yes | — | Unique identifier for accessibility (required) |
| `label` | `string` | no | — | Accessible label for the editor (required for screen readers) |
| `mode` | `"wysiwyg"` \| `"source"` | no | — | Editor display mode (two-way bindable) |
| `modeLabel` | `string` | no | — | Accessible label for the mode toggle (visually hidden) |
| `placeholder` | `string` | no | — | Placeholder text when empty |
| `readonly` | `boolean` | no | — | Read-only mode |
| `modeToggleVisible` | `boolean` | no | — | Show an inline toggle for switching between WYSIWYG and raw Markdown |
| `toolbarEnabled` | `boolean` | no | — | Show formatting toolbar (DEP-37) |
| `snapshotMode` | `boolean` | no | — | Snapshot mode for visual regression testing. When `true`: - Applies `caret-color: transparent` and `user-select: none` to the editor root via a `data-snapshot-mode` attribute, producing a stable visual state (no blinking cursor, no selection highlights). - Blurs any focused element inside the component on mount so the initial screenshot does not capture a focused ring or active caret. This is a purely visual / CSS concern. It does NOT affect editability, ProseMirror state, or any prop controlled by `readonly` / `mode`. |
| `value` | `string` | no | — | Current markdown content (two-way bindable) |
| `onValueChange` | `(opaque)` | no | — | Called when content changes Not expressible in JSON Schema; see the component types for the signature. |
| `onCommentShortcut` | `(opaque)` | no | — | Called when comment shortcut (Ctrl-Alt-c) is pressed (DEP-47) Not expressible in JSON Schema; see the component types for the signature. |
| `onModeChange` | `(opaque)` | no | — | Called when editor mode changes Not expressible in JSON Schema; see the component types for the signature. |
| `onPlaceholderDiagnosticsChange` | `(opaque)` | no | — | Called with the ordered placeholder diagnostics whenever that list changes. Token ranges index the Markdown `value`. Called with `[]` only to clear earlier diagnostics. Not expressible in JSON Schema; see the component types for the signature. |
| `onReady` | `(opaque)` | no | — | Called when the editor is ready (Milkdown initialized) Not expressible in JSON Schema; see the component types for the signature. |
| `onSelectionChange` | `(opaque)` | no | — | Called when selection changes (stub for DEP-39) Not expressible in JSON Schema; see the component types for the signature. |
| `onToolbarContextChange` | `(opaque)` | no | — | Notified whenever the toolbar context changes. Use this to host the formatting controls somewhere this component does not render — for example folding them into a surrounding application toolbar so the editor does not stack a second bar of its own. Pair it with `toolbarEnabled={false}`. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderCompletion` | `(opaque)` | no | — | Placeholder completion configuration (DEP-583). When provided, enables inline suggestion menu for {{…}} tokens in WYSIWYG mode. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderDecoration` | `(opaque)` | no | — | Placeholder decoration configuration (DEP-583). When provided, decorates invalid {{…}} tokens with CSS class and data attributes. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderDefinitions` | `(opaque)` | no | — | Allowed placeholders, as a JSON Schema or explicit candidates. Drives completion, invalid-token decoration and diagnostics from one catalog. Replacing the object updates the live editor without recreating it. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderValues` | `(opaque)` | no | — | Placeholder values for filled preview. Never used for completion, and never included in a diagnostic. Supplying values without `placeholderDefinitions`, or values that are not a plain JSON object, reports a configuration diagnostic. Not expressible in JSON Schema; see the component types for the signature. |
| `plugins` | `(opaque)` | no | — | Additional Milkdown plugins to load. Used for comment anchoring (DEP-39), decorations, and other extensions. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbar` | `(opaque)` | no | — | Custom toolbar content. When provided, replaces default toolbar. Receives ToolbarContext for building custom toolbar UI. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbarActions` | `(opaque)` | no | — | Additional toolbar actions (appended to default toolbar). Use this for adding buttons without replacing the entire toolbar. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbarLeading` | `(opaque)` | no | — | Leading toolbar content (prepended before default toolbar items). Useful for adding undo/redo or other leading actions. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Template placeholders

`placeholderDefinitions` is the recommended way to enable `{{path}}` placeholders. Pass either `{ schema }` (a JSON Schema object) or `{ candidates }`. The editor normalizes each definitions object once and uses that one catalog for completion, invalid-token decoration and diagnostics. Replace the object to change the allowed paths: the live editor updates through a metadata-only transaction, so the document, undo history, selection and `onValueChange` are untouched and the editor is never recreated.

`placeholderCompletion` and `placeholderDecoration` remain available as the low-level alternative, including async lookup, `minimumQueryLength` and `lookupDebounceMs`, and are now reactive too. They cannot be combined with `placeholderDefinitions`: the prop types reject the mix, and at runtime the editor reports `conflicting_configuration` at `placeholderDefinitions`, turns placeholder completion and decoration off, keeps editing, and resumes as soon as the conflict is removed. With no placeholder props at all, nothing is scanned, decorated or reported.

### Completion

Typing `{{` in eligible WYSIWYG text opens completion at zero query characters (the low-level path keeps its own `minimumQueryLength`). Filtering is a case-insensitive path prefix; insertion is always the canonical, case-sensitive path. Every match is listed in code-unit path order, eight rows are visible at a time, and the rest scroll. Each row shows the path, the declared types joined with `|` (or `unknown`) and the description, never a value.

A token must sit in one contiguous run of text with the same formatting. Code blocks, inline code and non-collapsed selections never open completion, a token never spans a formatting boundary, and link labels are eligible while link targets are not. Readonly editors show no completion.

- ArrowDown and ArrowUp move the active option and stop at the ends.
- Enter inserts the active option, never during IME composition.
- Tab dismisses without inserting, then does what Tab normally does in the editor: indents a list item, moves to the next table cell, or moves focus. The change Tab makes does not reopen the list; the dismissal lasts until your next edit.
- Escape dismisses and is consumed only while the list is open; a second Escape reaches enclosing handlers. A dismissal lasts until the next edit.
- Clicking or tapping an option inserts it without moving focus out of the editor. A pointer or touch gesture that scrolls the list or is cancelled inserts nothing, and a click from assistive technology with no pointer gesture inserts the option. A pointerdown outside dismisses.

Accepting replaces the whole in-progress token with one `{{path}}` and places the caret after it. The token includes path characters after the caret and, when only path characters (plus spaces or tabs) sit between the caret and it, the closing `}}`; otherwise prose up to a later `}}` is left alone. The acceptance is its own undo step: one undo restores the previous token, even if you kept typing right after it.

### Accessibility

The ProseMirror element keeps `role="textbox"` with `aria-multiline="true"`. While completion is configured it also has `aria-autocomplete="list"` and `aria-haspopup="listbox"`; `aria-controls` names the listbox only while it is visible, and `aria-activedescendant` names the active option. It never gets `aria-expanded`.

| Element | ID |
| --- | --- |
| Listbox (named "Placeholders") | `${id}-placeholder-listbox-wysiwyg` |
| Option | the listbox ID, a hyphen and the canonical path |
| Status region (`role="status"`, polite, atomic) | `${id}-placeholder-status` |
| Diagnostics summary | `${id}-placeholder-diagnostics` |
| Instructions (visually hidden) | `${id}-placeholder-instructions` |

The status region is always rendered and announces "N placeholders available", "1 placeholder available", "No matching placeholders", or the active option as "path, types, i of N". The instructions read "Type two opening braces to insert a placeholder. Use arrow keys and Enter to choose; Escape or Tab dismisses." The editor adds the instructions and diagnostics IDs to `aria-describedby` after any IDs you pass.

### Diagnostics

`onPlaceholderDiagnosticsChange` receives the ordered definition, configuration and token diagnostics, and fires only when that list changes (compared by code, path, location and message). It fires with `[]` only to clear diagnostics it reported before. Token ranges are UTF-16 offsets into the Markdown `value`, recomputed when `value` updates. Diagnostics never contain placeholder values. The same list renders as a visible summary below the editor.

Configuration errors use a `configuration` location:

- `conflicting_configuration` at `placeholderDefinitions` when definitions are mixed with the low-level props.
- `invalid_definitions` at `placeholderDefinitions` when `placeholderValues` is supplied without definitions.
- `invalid_values` at `placeholderValues` when values are not a plain JSON object.

Invalid tokens in the WYSIWYG document get the `template-placeholder-invalid` class (or the low-level `invalidClassName`), a wavy underline as the non-color cue, and a `data-placeholder-validation-reason` attribute set to one of `malformed_token`, `invalid_path_format`, `blocked_path` or `unknown_placeholder`.

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
