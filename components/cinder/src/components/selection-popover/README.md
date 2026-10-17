# SelectionPopover

A floating toolbar that appears near a text selection and offers a comment-on-selection action with an inline composer. The component uses fixed-position Floating UI geometry, so the supplied selection anchor can flip or shift when it is near a viewport edge.

## Choosing this component

Use `SelectionPopover` when you want readers to annotate or comment on a highlighted range of text — for example, in a document editor, review tool, or article surface. It is designed specifically for selection-scoped actions. For generic floating content or popovers unrelated to text selection, use the `Popover` component instead.

`SelectionPopover` does not render persistent comment highlights. Keep saved comment anchors in your own markup, or use `ReviewEditor` and the commentary anchoring utilities when you need editor-backed anchor tracking.

## How it positions

The `position` prop accepts a **viewport-relative anchor point** — the same coordinate space returned by `Range.getClientRects()` and `Range.getBoundingClientRect()`. A typical consumer computes the anchor from the selected range and passes it directly:

```ts
const range = selection.getRangeAt(0);
const rect =
  Array.from(range.getClientRects()).find((clientRect) => {
    return clientRect.width > 0 && clientRect.height > 0;
  }) ?? range.getBoundingClientRect();
position = { x: rect.left + rect.width / 2, y: rect.top, height: rect.height };
```

The component treats that point as a Floating UI virtual anchor, not as the panel's top-left corner. It prefers an above-selection placement, but shifts or flips near viewport edges. Coordinates are **not** relative to a containing element — do not pass offsetLeft/offsetTop or any container-relative value.

## Usage

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { SelectionPopoverPosition } from '@lostgradient/cinder';
  import { SelectionPopover } from '@lostgradient/cinder';

  type Comment = { id: string; body: string };

  let isOpen = $state(false);
  let position = $state<SelectionPopoverPosition | null>(null);
  let comments = $state<Comment[]>([]);

  /**
   * Bound reference to the text surface element.
   * `selectionchange` is a document-level event — the handler uses this
   * reference to scope detection to selections inside the surface only.
   */
  let surfaceElement = $state<HTMLElement | null>(null);

  onMount(() => {
    function handleSelectionChange(): void {
      if (!surfaceElement) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        isOpen = false;
        position = null;
        return;
      }
      const range = selection.getRangeAt(0);
      if (!surfaceElement.contains(range.commonAncestorContainer)) {
        isOpen = false;
        position = null;
        return;
      }
      const rect =
        Array.from(range.getClientRects()).find((clientRect) => {
          return clientRect.width > 0 && clientRect.height > 0;
        }) ?? range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        isOpen = false;
        position = null;
        return;
      }
      position = { x: rect.left + rect.width / 2, y: rect.top, height: rect.height };
      isOpen = true;
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  });

  function handleClose(): void {
    isOpen = false;
    position = null;
  }

  function handleCommentSubmit(body: string): void {
    comments = [...comments, { id: crypto.randomUUID(), body }];
    handleClose();
  }
</script>

<article bind:this={surfaceElement}>
  <p>Select text in this paragraph to comment on it.</p>
</article>

<SelectionPopover
  id="my-selection-popover"
  open={isOpen}
  {position}
  onClose={handleClose}
  onCommentSubmit={handleCommentSubmit}
/>
```

## Custom actions

By default the popover offers the comment flow: an "Add comment" button that expands into an inline composer. Pass an `actions` snippet to replace that flow with your own controls, such as a quote action. The snippet is called with `{ close }`; calling `close` dismisses the popover through the same path as Escape and an outside click, so `onClose` fires.

```svelte
<SelectionPopover
  id="quote-popover"
  open={isOpen}
  {position}
  label="Quote selection"
  onClose={handleClose}
>
  {#snippet actions({ close })}
    <Button
      size="sm"
      variant="ghost"
      label="Quote"
      onclick={() => {
        quoteSelection();
        close();
      }}
    />
  {/snippet}
</SelectionPopover>
```

With `actions` given:

- `onCommentSubmit` and `onExpand` are never called, and Enter and Space no longer expand the popover.
- Focus moves to the first action once the popover is positioned and open, and returns to the previously focused element when it closes.
- Escape and a pointer press outside call `onClose`, exactly as without `actions`.
- Selection tracking stays with the caller, as in the other examples.

The `label` prop sets the toolbar's accessible name and defaults to "Selection actions". Give it a name that fits the actions you render.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-selection-popover`. |
| `id` | `string` | yes | — | Unique identifier for the popover. |
| `label` | `string` | no | `"Selection actions"` | Accessible name of the toolbar. |
| `open` | `boolean` | no | — | Whether the popover is visible. |
| `actions` | `(opaque)` | no | — | Caller-supplied actions that replace the built-in comment button and inline composer. Called with `{ close }`; `close` dismisses the popover through the same path as Escape and an outside click, so `onClose` fires. When given, `onCommentSubmit` and `onExpand` are never called, Enter and Space no longer expand the popover, and focus moves to the first action when the popover opens. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the composer is canceled. Not expressible in JSON Schema; see the component types for the signature. |
| `onClose` | `(opaque)` | no | — | Called when the popover should close. Not expressible in JSON Schema; see the component types for the signature. |
| `onCommentSubmit` | `(opaque)` | no | — | Called when a comment is submitted. Not expressible in JSON Schema; see the component types for the signature. |
| `onExitComplete` | `(opaque)` | no | — | Called once the popover's exit transition has genuinely finished and it has fully unmounted from the layout (see `_internal/OVERLAY-POLICY.md` § "Transition lifecycle"). This component intentionally never unmounts ITS OWN root element while closing — `data-cinder-visible`/ `data-cinder-closing` drive the retained fade instead of an `{#if}` gate — so a consumer that wraps this component in its own `{#if}` keyed directly on the same state that flips `open` false would destroy the whole component instance before its exit transition ever gets a chance to play. Use this callback to decouple that wrapping condition from the live open state: keep the consumer's own mount gate true until this fires, then clear it. Not expressible in JSON Schema; see the component types for the signature. |
| `onExpand` | `(opaque)` | no | — | Called when the compact action expands into the composer. Not expressible in JSON Schema; see the component types for the signature. |
| `position` | `(opaque)` | yes | — | Viewport-relative anchor point for the popover. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
