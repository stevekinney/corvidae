# @repo/editor

`@repo/editor` is Cinder's Svelte 5 markdown editing, review, and diffing surface—`MarkdownEditor` (Milkdown/ProseMirror-based rich editing), `ReviewEditor` (threaded comments, front matter, export), and `DiffViewer` (word-level Markdown diffing)—packaged separately so applications that only render buttons and tables do not install milkdown, prosemirror, or their own copy of `@repo/markdown`.

## Workspace usage

Declare `"@repo/editor": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@repo/editor`; the consumer compiles it. Shared external versions come from the root Bun catalog.

Import components by name. The root entry loads the required Cinder and editor styles, and the consuming application compiles Svelte source:

```svelte
<script lang="ts">
  import { MarkdownEditor } from '@repo/editor';
  let source = $state('# Notes');
</script>

<MarkdownEditor id="post-body" value={source} onchange={(next) => (source = next)} />
```

`id` is required because it supplies the component's accessibility identifiers.

## Components

- `MarkdownEditor` provides rich Markdown editing.
- `ReviewEditor` composes editing, threaded comments, front matter, and export.
- `DiffViewer` provides Markdown diffs, front matter, and revert controls.

All components, supported types, schemas, variables, and headless utilities are named exports from `@repo/editor`.

### DiffViewer toolbar override

`DiffViewer`'s `toolbar` snippet prop is **total replacement**, not inversion of control: supplying it removes the entire built-in toolbar—the view-mode control, stat badges, copy and revert actions, and change navigation—with whatever the snippet renders instead. Unlike `@repo/chat`'s `messagePart`/`row` overrides (see the "Overriding built-in rendering" section of [`@repo/chat`'s README](../chat/README.md)), `toolbar` receives a read-only `DiffToolbarContext` (`hasChanges`, `hunks`, `stats`, `viewMode`) and no `renderDefault` snippet—there is no way back to the built-in toolbar from inside an override.

This is intentional, not an oversight: a caller embedding a standalone diff view outside a chat or review context may want a fully custom toolbar with no built-in chrome at all, which total replacement gives directly. Chat's built-in row and part rendering carries state (streaming, tool-call presentation, artifact resolution) that most overrides want to keep and only augment—`DiffViewer`'s toolbar does not carry equivalent state, so replacing it outright is a reasonable default rather than a gap.

One sharp edge worth knowing: `toolbarActions`—documented as the way to add a button to the toolbar _without_ replacing it—is only rendered from inside the _built-in_ toolbar. Supplying both `toolbar` and `toolbarActions` silently drops `toolbarActions`, since the override branch never renders it. If you need both custom chrome and the extra action, put the action's markup directly inside your `toolbar` snippet instead of relying on `toolbarActions`.

## Package boundary

Editor owns its Milkdown and ProseMirror dependencies. Keeping it separate lets Cinder components stay independent of the editing runtime. The application uses the root catalog and lockfile to resolve shared versions.
