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
| `showModeToggle` | `boolean` | no | — | Show an inline toggle for switching between WYSIWYG and raw Markdown |
| `showToolbar` | `boolean` | no | — | Show formatting toolbar (DEP-37) |
| `snapshotMode` | `boolean` | no | — | Snapshot mode for visual regression testing. When `true`: - Applies `caret-color: transparent` and `user-select: none` to the editor root via a `data-snapshot-mode` attribute, producing a stable visual state (no blinking cursor, no selection highlights). - Blurs any focused element inside the component on mount so the initial screenshot does not capture a focused ring or active caret. This is a purely visual / CSS concern. It does NOT affect editability, ProseMirror state, or any prop controlled by `readonly` / `mode`. |
| `value` | `string` | no | — | Current markdown content (two-way bindable) |
| `onchange` | `(opaque)` | no | — | Called when content changes Not expressible in JSON Schema; see the component types for the signature. |
| `oncommentshortcut` | `(opaque)` | no | — | Called when comment shortcut (Ctrl-Alt-c) is pressed (DEP-47) Not expressible in JSON Schema; see the component types for the signature. |
| `onmodechange` | `(opaque)` | no | — | Called when editor mode changes Not expressible in JSON Schema; see the component types for the signature. |
| `onready` | `(opaque)` | no | — | Called when the editor is ready (Milkdown initialized) Not expressible in JSON Schema; see the component types for the signature. |
| `onselectionchange` | `(opaque)` | no | — | Called when selection changes (stub for DEP-39) Not expressible in JSON Schema; see the component types for the signature. |
| `ontoolbarcontextchange` | `(opaque)` | no | — | Notified whenever the toolbar context changes. Use this to host the formatting controls somewhere this component does not render — for example folding them into a surrounding application toolbar so the editor does not stack a second bar of its own. Pair it with `showToolbar={false}`. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderCompletion` | `(opaque)` | no | — | Placeholder completion configuration (DEP-583). When provided, enables inline suggestion menu for {{…}} tokens in WYSIWYG mode. Not expressible in JSON Schema; see the component types for the signature. |
| `placeholderDecoration` | `(opaque)` | no | — | Placeholder decoration configuration (DEP-583). When provided, decorates invalid {{…}} tokens with CSS class and data attributes. Not expressible in JSON Schema; see the component types for the signature. |
| `plugins` | `(opaque)` | no | — | Additional Milkdown plugins to load. Used for comment anchoring (DEP-39), decorations, and other extensions. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbar` | `(opaque)` | no | — | Custom toolbar content. When provided, replaces default toolbar. Receives ToolbarContext for building custom toolbar UI. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbarActions` | `(opaque)` | no | — | Additional toolbar actions (appended to default toolbar). Use this for adding buttons without replacing the entire toolbar. Not expressible in JSON Schema; see the component types for the signature. |
| `toolbarLeading` | `(opaque)` | no | — | Leading toolbar content (prepended before default toolbar items). Useful for adding undo/redo or other leading actions. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
