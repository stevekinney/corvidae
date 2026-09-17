<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, SelectionPopover, type SelectionPopoverPosition } from '@repo/cinder';

  type ExistingComment = { id: string; quote: string; body: string };
  const existingComments: ExistingComment[] = [
    {
      id: 'existing-comment-platform',
      quote: 'platform review workflow',
      body: 'This phrase already has a persisted comment. The highlight is rendered by the consumer.',
    },
    {
      id: 'existing-comment-anchors',
      quote: 'anchored selections visible',
      body: 'ReviewEditor uses commentary anchor decorations for the full editor-backed version.',
    },
  ];
  let surfaceElement = $state<HTMLElement | null>(null);
  let isOpen = $state(false);
  let position = $state<SelectionPopoverPosition | null>(null);
  let activeCommentId = $state(existingComments[0]?.id ?? null);
  let submittedComments = $state<string[]>([]);
  let toggledOpen = $state(false);
  let toggledPosition = $state<SelectionPopoverPosition | null>(null);
  let showClamping = $state(false);
  const activeComment = $derived(
    existingComments.find((comment) => comment.id === activeCommentId) ?? null,
  );

  function selectionAnchor(surface: HTMLElement): SelectionPopoverPosition | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return null;
    const rect =
      Array.from(range.getClientRects()).find(
        (candidate) => candidate.width > 0 && candidate.height > 0,
      ) ?? range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top, height: rect.height };
  }
  onMount(() => {
    const handleSelectionChange = () => {
      if (!surfaceElement) return;
      const popover = document.getElementById('basic-selection-popover');
      if (
        popover?.contains(document.activeElement) ||
        popover?.hasAttribute('data-cinder-expanded')
      )
        return;
      const anchor = selectionAnchor(surfaceElement);
      position = anchor;
      isOpen = anchor !== null;
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  });
  function closeBasic() {
    isOpen = false;
    position = null;
  }
  function submitBasic(body: string) {
    submittedComments = [...submittedComments, body];
    closeBasic();
  }
  function openToggled() {
    const anchor = document.querySelector<HTMLElement>('[data-testid="external-trigger-anchor"]');
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    toggledPosition = { x: rect.left + rect.width / 2, y: rect.top, height: rect.height };
    toggledOpen = true;
  }
  function closeToggled() {
    toggledOpen = false;
    toggledPosition = null;
  }
  function selectExisting(event: MouseEvent, id: string) {
    event.preventDefault();
    activeCommentId = id;
  }
</script>

<div class="selection-fixture">
  <article bind:this={surfaceElement} class="selection-surface">
    <p>
      The SelectionPopover appears near highlighted text — its position is derived from the selected
      range. Select any portion of this paragraph to see it appear near your selection.
    </p>
    <p>
      Clicking the comment icon expands the composer. Submit with the send button and keyboard
      shortcuts. The composer collapses back to the icon after submission.
    </p>
    <p>
      Consumers can keep the <a
        href="#existing-comment-platform"
        data-testid="existing-comment-anchor"
        data-active={activeCommentId === 'existing-comment-platform'}
        aria-current={activeCommentId === 'existing-comment-platform' ? 'true' : undefined}
        aria-controls="existing-comment-panel"
        onclick={(event) => selectExisting(event, 'existing-comment-platform')}
        >platform review workflow</a
      > visibly connected to saved comments.
    </p>
    <p>
      ReviewEditor keeps <a
        href="#existing-comment-anchors"
        data-testid="existing-comment-anchor"
        data-active={activeCommentId === 'existing-comment-anchors'}
        aria-current={activeCommentId === 'existing-comment-anchors' ? 'true' : undefined}
        aria-controls="existing-comment-panel"
        onclick={(event) => selectExisting(event, 'existing-comment-anchors')}
        >anchored selections visible</a
      > as the document changes.
    </p>
  </article>
  <aside id="existing-comment-panel" aria-live="polite">
    {#if activeComment}<h4>{activeComment.quote}</h4>
      <p>{activeComment.body}</p>{/if}
  </aside>
  <div class="external-controls">
    <p>
      The comment action anchors to <mark data-testid="external-trigger-anchor"
        >this visible phrase</mark
      >.
    </p>
    <Button
      label="Open popover"
      aria-expanded={toggledOpen}
      aria-controls="toggled-selection-popover"
      disabled={toggledOpen}
      onclick={openToggled}
    />
    <Button
      label="Show clamping test popovers"
      aria-expanded={showClamping}
      onclick={() => (showClamping = !showClamping)}
    />
  </div>
</div>

<SelectionPopover
  id="basic-selection-popover"
  open={isOpen}
  {position}
  onClose={closeBasic}
  onCommentSubmit={submitBasic}
/>
<SelectionPopover
  id="toggled-selection-popover"
  open={toggledOpen}
  position={toggledPosition}
  onClose={closeToggled}
/>
<SelectionPopover
  id="viewport-clamp-negative-x"
  open={showClamping}
  position={{ x: -100, y: 300 }}
/>
<SelectionPopover
  id="viewport-clamp-overflow-x"
  open={showClamping}
  position={{ x: 99999, y: 340 }}
/>
<SelectionPopover
  id="viewport-clamp-negative-y"
  open={showClamping}
  position={{ x: 480, y: -50 }}
/>

<style>
  .selection-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 56rem;
    padding-block-end: 120vh;
  }
  .selection-surface {
    max-inline-size: 36rem;
    line-height: 1.6;
    user-select: text;
    cursor: text;
  }
  .selection-surface p {
    margin: 0 0 0.75rem;
  }
  .selection-surface a {
    color: inherit;
    text-decoration-color: var(--cinder-accent-solid);
  }
  :global(.selection-surface mark) {
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 84%);
  }
  .external-controls {
    display: grid;
    gap: 0.5rem;
  }
  .external-controls p {
    margin: 0;
  }
</style>
