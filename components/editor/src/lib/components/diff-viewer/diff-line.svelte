<script lang="ts" module>
  import type { LineDiff } from '@lostgradient/markdown';

  import type { DiffViewerMode } from './diff-viewer.types.ts';

  export type DiffLineProps = {
    /** The line diff data */
    diff: LineDiff;
    /** Current view mode */
    viewMode: DiffViewerMode;
    /** Whether this line is selected */
    selected?: boolean;
    /** Called when user clicks this line (for navigation) */
    onselect?: (() => void) | undefined;
    /** Additional CSS classes */
    class?: string;
  };
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';

  let { diff, viewMode, selected = false, onselect, class: className }: DiffLineProps = $props();

  /**
   * Whether this line should be visible based on view mode.
   * - Unified: show all line types
   * - Final: hide 'removed' lines (show current state)
   * - Original: hide 'added' lines (show baseline)
   */
  const isVisible = $derived.by(() => {
    if (diff.type === 'same') return true;
    if (viewMode === 'unified') return true;
    if (viewMode === 'final') return diff.type !== 'removed';
    if (viewMode === 'original') return diff.type !== 'added';
    return true;
  });

  /**
   * Whether this line is interactive (clickable for selection).
   * Same lines are not selectable.
   */
  const isInteractive = $derived(diff.type !== 'same' && onselect !== undefined);
  const accessibleLineLabel = $derived.by(() => {
    const text =
      diff.type === 'modified'
        ? viewMode === 'original'
          ? diff.oldText
          : viewMode === 'final'
            ? diff.newText
            : `${diff.oldText} changed to ${diff.newText}`
        : diff.text;
    const typeLabel =
      diff.type === 'added'
        ? 'Added line'
        : diff.type === 'removed'
          ? 'Removed line'
          : 'Modified line';
    return `${typeLabel}: ${text || 'blank line'}`;
  });
  const modifiedOldLineLabel = $derived.by(() =>
    diff.type === 'modified' ? `Removed line: ${diff.oldText || 'blank line'}` : 'Removed line',
  );
  const modifiedNewLineLabel = $derived.by(() =>
    diff.type === 'modified' ? `Added line: ${diff.newText || 'blank line'}` : 'Added line',
  );
  const removedGutter = $derived(viewMode === 'final' ? '' : '-');
  const modifiedSideGutter = $derived(
    viewMode === 'unified' ? '' : viewMode === 'final' ? '+' : '-',
  );
</script>

{#if isVisible}
  {#if diff.type === 'same'}
    <!-- Same line: static div, not interactive -->
    <div class={classNames('diff-line', className)}>
      <span class="diff-gutter"></span>
      <span class="diff-text">{diff.text || '\u00A0'}</span>
    </div>
  {:else if diff.type === 'added'}
    <!-- Added line -->
    {#if isInteractive}
      <button
        class={classNames('diff-line diff-line-added', className)}
        data-selected={selected}
        aria-label={accessibleLineLabel}
        onclick={onselect}
        type="button"
      >
        <span class="diff-gutter">+</span>
        <span class="diff-text">{diff.text || '\u00A0'}</span>
      </button>
    {:else}
      <div
        class={classNames('diff-line diff-line-added', className)}
        data-selected={selected}
        role="group"
        aria-label={accessibleLineLabel}
      >
        <span class="diff-gutter">+</span>
        <span class="diff-text">{diff.text || '\u00A0'}</span>
      </div>
    {/if}
  {:else if diff.type === 'removed'}
    <!-- Removed line: strikethrough only in unified view, plain text in original view -->
    {@const showStrikethrough = viewMode === 'unified'}
    {#if isInteractive}
      <button
        class={classNames(
          'diff-line',
          showStrikethrough ? 'diff-line-removed' : 'diff-line-removed-original',
          className,
        )}
        data-selected={selected}
        aria-label={accessibleLineLabel}
        onclick={onselect}
        type="button"
      >
        <span class="diff-gutter">{removedGutter}</span>
        <span class="diff-text">
          {#if showStrikethrough}
            <del>{diff.text || '\u00A0'}</del>
          {:else}
            {diff.text || '\u00A0'}
          {/if}
        </span>
      </button>
    {:else}
      <div
        class={classNames(
          'diff-line',
          showStrikethrough ? 'diff-line-removed' : 'diff-line-removed-original',
          className,
        )}
        data-selected={selected}
        role="group"
        aria-label={accessibleLineLabel}
      >
        <span class="diff-gutter">{removedGutter}</span>
        <span class="diff-text">
          {#if showStrikethrough}
            <del>{diff.text || '\u00A0'}</del>
          {:else}
            {diff.text || '\u00A0'}
          {/if}
        </span>
      </div>
    {/if}
  {:else if diff.type === 'modified'}
    <!-- Modified line: unified renders paired old/new rows; side modes render one side. -->
    {@const lineClass =
      viewMode === 'unified'
        ? 'diff-line-modified'
        : viewMode === 'final'
          ? 'diff-line-modified-final'
          : 'diff-line-modified-original'}
    {@const displayText =
      viewMode === 'unified' ? null : viewMode === 'final' ? diff.newText : diff.oldText}

    {#if viewMode === 'unified'}
      {#if isInteractive}
        <button
          class={classNames('diff-line diff-line-removed', lineClass, className)}
          data-selected={selected}
          aria-label={modifiedOldLineLabel}
          onclick={onselect}
          type="button"
        >
          <span class="diff-gutter">-</span>
          <span class="diff-text"><del>{diff.oldText || '\u00A0'}</del></span>
        </button>
        <button
          class={classNames('diff-line diff-line-added', lineClass, className)}
          data-selected={selected}
          aria-label={modifiedNewLineLabel}
          onclick={onselect}
          type="button"
        >
          <span class="diff-gutter">+</span>
          <span class="diff-text">{diff.newText || '\u00A0'}</span>
        </button>
      {:else}
        <div
          class={classNames('diff-line diff-line-removed', lineClass, className)}
          data-selected={selected}
          role="group"
          aria-label={modifiedOldLineLabel}
        >
          <span class="diff-gutter">-</span>
          <span class="diff-text"><del>{diff.oldText || '\u00A0'}</del></span>
        </div>
        <div
          class={classNames('diff-line diff-line-added', lineClass, className)}
          data-selected={selected}
          role="group"
          aria-label={modifiedNewLineLabel}
        >
          <span class="diff-gutter">+</span>
          <span class="diff-text">{diff.newText || '\u00A0'}</span>
        </div>
      {/if}
    {:else}
      {#if isInteractive}
        <button
          class={classNames('diff-line', lineClass, className)}
          data-selected={selected}
          aria-label={accessibleLineLabel}
          onclick={onselect}
          type="button"
        >
          <span class="diff-gutter">{modifiedSideGutter}</span>
          <span class="diff-text">{displayText || '\u00A0'}</span>
        </button>
      {:else}
        <div
          class={classNames('diff-line', lineClass, className)}
          data-selected={selected}
          role="group"
          aria-label={accessibleLineLabel}
        >
          <span class="diff-gutter">{modifiedSideGutter}</span>
          <span class="diff-text">{displayText || '\u00A0'}</span>
        </div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  .diff-line {
    display: flex;
    width: 100%;
    min-height: 1.5em;
  }

  button.diff-line {
    all: unset;
    display: flex;
    width: 100%;
    min-height: 1.5em;
    cursor: pointer;
    box-sizing: border-box;
  }

  /* Each diff line is a full-bleed row inside the scrollable viewer; an outset
     ring is clipped at the row edges, so paint an INSET ring (Strategy B-inset). */
  button.diff-line:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: inset 0 0 0 var(--cinder-ring-width)
      var(--_cinder-diff-line-ring, var(--cinder-ring-color));
  }

  @media (forced-colors: active) {
    button.diff-line:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: calc(var(--cinder-ring-width) * -1);
    }
  }

  .diff-line[data-selected='true'] {
    outline: var(--cinder-ring-width) solid var(--cinder-accent-solid);
    outline-offset: calc(var(--cinder-ring-width) * -1);
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 90%);
    z-index: 1;
  }

  .diff-gutter {
    flex-shrink: 0;
    width: 1.5rem;
    padding: var(--cinder-space-0-5) 0;
    text-align: center;
    color: var(--cinder-text-muted);
    user-select: none;
    font-weight: var(--cinder-font-medium);
  }

  .diff-text {
    flex: 1;
    padding: var(--cinder-space-0-5) var(--cinder-space-3);
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  /* Added lines (DEP-47: underline provides non-color indicator for a11y) */
  .diff-line-added .diff-text {
    background: var(--cinder-status-success-background);
    text-decoration: underline;
    text-decoration-color: var(--cinder-status-success-solid);
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }

  .diff-line-added .diff-gutter {
    color: var(--cinder-status-success-text);
  }

  /* Removed lines */
  .diff-line-removed .diff-text {
    background: var(--cinder-status-danger-background);
  }

  .diff-line-removed .diff-gutter {
    color: var(--cinder-status-danger-text);
  }

  .diff-line-removed del {
    text-decoration: line-through;
    opacity: 0.8;
  }

  /* Removed lines in original view: render as plain text (baseline content) */
  .diff-line-removed-original .diff-text {
    background: transparent;
  }

  .diff-line-removed-original .diff-gutter {
    color: var(--cinder-text-muted);
  }

  /* Modified lines (unified view) */
  .diff-line-modified .diff-text {
    background: color-mix(in oklch, var(--cinder-status-info-background), transparent 85%);
  }

  .diff-line-modified .diff-gutter {
    color: var(--cinder-status-info-text);
  }

  /* Modified in final view (highlight subtly) */
  .diff-line-modified-final .diff-text {
    background: color-mix(in oklch, var(--cinder-status-info-background), transparent 85%);
  }

  .diff-line-modified-final .diff-gutter {
    color: var(--cinder-status-info-text);
  }

  /* Modified in original view (highlight subtly) */
  .diff-line-modified-original .diff-text {
    background: color-mix(in oklch, var(--cinder-status-info-background), transparent 85%);
  }

  .diff-line-modified-original .diff-gutter {
    color: var(--cinder-status-info-text);
  }
</style>
