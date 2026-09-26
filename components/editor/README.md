# @lostgradient/editor

`@lostgradient/editor` is Cinder's [Svelte](https://svelte.dev/) Markdown editing, review, and diffing surface. It provides `MarkdownEditor` for [Milkdown](https://milkdown.dev/)- and [ProseMirror](https://prosemirror.net/)-based rich editing, `ReviewEditor` for threaded comments and export, and `DiffViewer` for word-level Markdown diffs. Keeping that machinery here means an application that only renders buttons and tables does not install an editing runtime for moral support.

## Workspace usage

Declare `"@lostgradient/editor": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@lostgradient/editor`; the consumer compiles it. Shared external versions come from the root Bun catalog.

Import components by name. The root entry loads the required Cinder and editor styles, and the consuming application compiles Svelte source:

```svelte
<script lang="ts">
  import { MarkdownEditor } from '@lostgradient/editor';
  let source = $state('# Notes');
</script>

<MarkdownEditor id="post-body" value={source} onValueChange={(next) => (source = next)} />
```

`id` is required because it supplies the component's accessibility identifiers.

## Components

- `MarkdownEditor` provides rich Markdown editing.
- `ReviewEditor` composes editing, threaded comments, front matter, and export.
- `DiffViewer` provides Markdown diffs, front matter, and revert controls.

All components, supported types, schemas, variables, and headless utilities are named exports from `@lostgradient/editor`.

### DiffViewer toolbar override

`DiffViewer`'s `toolbar` snippet prop is **total replacement**, not inversion of control: supplying it removes the entire built-in toolbar—the view-mode control, stat badges, copy and revert actions, and change navigation—with whatever the snippet renders instead. Unlike `@lostgradient/chat`'s `messagePart`/`row` overrides (see the "Overriding built-in rendering" section of [`@lostgradient/chat`'s README](../chat/README.md)), `toolbar` receives a read-only `DiffToolbarContext` (`hasChanges`, `hunks`, `stats`, `viewMode`) and no `renderDefault` snippet—there is no way back to the built-in toolbar from inside an override.

This is intentional, not an oversight: a caller embedding a standalone diff view outside a chat or review context may want a fully custom toolbar with no built-in chrome at all, which total replacement gives directly. Chat's built-in row and part rendering carries state (streaming, tool-call presentation, artifact resolution) that most overrides want to keep and only augment—`DiffViewer`'s toolbar does not carry equivalent state, so replacing it outright is a reasonable default rather than a gap.

One sharp edge worth knowing: `toolbarActions`—documented as the way to add a button to the toolbar _without_ replacing it—is only rendered from inside the _built-in_ toolbar. Supplying both `toolbar` and `toolbarActions` silently drops `toolbarActions`, since the override branch never renders it. If you need both custom chrome and the extra action, put the action's markup directly inside your `toolbar` snippet instead of relying on `toolbarActions`.

## Breaking changes

### MarkdownEditor template placeholders (COR-526)

- **Low-level props are reactive**: `placeholderCompletion` and `placeholderDecoration` used to be read once when the editor mounted. Replacing either object now updates the live editor without recreating it. They can no longer be combined with the new `placeholderDefinitions`; see the component README.
- **Popup rows**: rows used to show the path above one `types — description` line, and only the first eight matches existed. Rows now have separate path, types (`|`-joined, or `unknown`) and description elements. Every match is listed and scrolls, with eight visible rows. Matches sort by code-unit path order instead of `localeCompare`.
- **Keyboard and pointer**: arrow keys used to wrap around; they now stop at the first and last option. Tab used to accept the active option; it now dismisses without inserting and then does what Tab normally does in the editor: it indents a list item, moves to the next table cell, or moves focus. The document change that Tab makes does not reopen the list. Escape used to be consumed whenever completion was tracking a token; it is now consumed only while the list is visible, and the dismissal lasts until the next edit. A `mousedown` on an option used to insert it; a click or tap now inserts it, while pointerdown only keeps the editor selection. A pointer or touch gesture that scrolls the list or is cancelled inserts nothing; a click with no preceding pointer gesture, such as one sent by assistive technology, inserts the option.
- **Undo after accepting**: accepting used to join the surrounding typing in one undo step. The acceptance is now its own undo step: typing immediately before or after it undoes separately.
- **Replacement range**: accepting inside a closed token used to replace everything up to the next `}}`. When the text between the caret and that `}}` is not a path (ignoring spaces and tabs), only the opener and the path characters after the caret are replaced, so prose such as `{{ to open and }}` survives.
- **No matches**: with no async lookup, completion used to close silently when nothing matched. It now stays hidden while the status region announces "No matching placeholders".
- **Token scanning**: completion and invalid-token decoration used to scan each block's whole text, across formatting and inline code. They now scan each run of identically formatted text, so tokens in inline code or code blocks are never decorated and a token can no longer cross a formatting boundary. `data-placeholder-validation-reason` can now be `blocked_path` as well as `malformed_token`, `invalid_path_format` and `unknown_placeholder`.
- **Editing element attributes**: the ProseMirror element now always has `aria-multiline="true"`. A caller's `aria-describedby` is merged with the placeholder instructions and diagnostics IDs instead of being written alone.
- **Editor API**: `EditorConfig.placeholderCompletion` and `EditorConfig.placeholderDecoration` are replaced by `EditorConfig.placeholders` (`{ definitions?, completion?, decoration?, valuesStatus? }`), with `placeholderListboxId`, `onPlaceholderStatusChange`, and `EditorState.setPlaceholderConfiguration()` for live replacement. `EditorAttachmentOptions.getPlaceholderCompletion` and `getPlaceholderDecoration` are replaced by `getPlaceholderConfiguration`. The placeholder plugins are installed on every editor and stay inert until configured. `createTemplateCompletionPlugin(getConfiguration)` is now `createTemplateCompletionPlugin({ listboxId?, onStatusChange? })`, and `createTemplateInvalidDecorationPlugin(getCandidates, getInvalidClassName?)` is now `createTemplateInvalidDecorationPlugin(initialConfiguration)`. Both read their configuration from `createTemplatePlaceholderConfigurationPlugin()`, which must be installed with them.
- **Styles**: the completion popup and invalid-token styles moved from the component's scoped styles into `prosemirror.css`, inside the `cinder.components` layer.

### MarkdownEditor source-mode history (COR-521)

- **Undo and redo in source mode**: the raw Markdown textarea used to rely on the browser's native textarea undo stack, which a value the component wrote itself (a completion acceptance, or a value change from the parent) could reset or skip. Source mode now keeps its own history from the moment the textarea mounts, whether or not placeholders are configured. Mod-Z undoes; Mod-Shift-Z, and Ctrl-Y on Windows, redo; the browser's Undo and Redo commands (`historyUndo` and `historyRedo` input events) replay the same history, and native undo never runs as well. Each ordinary input event is one step, with no time-based grouping; one complete IME composition is one step; one placeholder acceptance is one step. A new edit clears redo. An external `value` change or `setMarkdown()` clears the history and starts from the new text; placeholder configuration changes do not. Switching to the rich editor and back starts a fresh history, and readonly editors do not intercept the shortcuts. Each undo or redo updates `value` and calls `onValueChange` once.

## Package boundary

Editor owns its Milkdown and ProseMirror dependencies. Keeping it separate lets Cinder components stay independent of the editing runtime. The application uses the root catalog and lockfile to resolve shared versions.
