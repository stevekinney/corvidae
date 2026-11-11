<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ChatAttachment } from './chat-attachment.ts';

  export interface ChatAttachmentPreviewProps {
    attachment: ChatAttachment;
    class?: string;
    /** A control drawn at the end of the chip, inside its border, such as Remove. */
    action?: Snippet | undefined;
  }
</script>

<script lang="ts">
  import { classNames } from '../../../utilities/class-names.ts';
  import { formatBytes } from '../../../utilities/format-bytes.ts';
  import { fileTypeBadge, splitFileName, uploadPercent } from './attachment-tile.ts';

  let { attachment, class: className, action }: ChatAttachmentPreviewProps = $props();

  const badge = $derived(fileTypeBadge(attachment.file.name, attachment.kind));
  const name = $derived(splitFileName(attachment.file.name));
  const percent = $derived(
    attachment.status === 'uploading' ? uploadPercent(attachment.progress) : undefined,
  );
</script>

<!--
  An attached file is a tile: a type badge, the file's name (truncated in the middle, so the
  extension always shows), its size and, while it uploads, how far along it is, then an optional
  control at its end. A file that failed keeps its tile, in the danger colour; its reason is drawn
  beside it by the composer.
-->
<span
  class={classNames('chat-attachment-preview', className)}
  data-kind={attachment.kind}
  data-state={attachment.status}
  data-error={attachment.status === 'error' || undefined}
  data-pending={attachment.status === 'pending' || attachment.status === 'uploading' || undefined}
>
  <span class="chat-attachment-preview-badge" aria-hidden="true">{badge}</span>
  <span class="chat-attachment-preview-name" title={attachment.file.name} dir="auto"
    ><span class="chat-attachment-preview-stem">{name.stem}</span><span
      class="chat-attachment-preview-extension">{name.extension}</span
    ></span
  >
  <span class="chat-attachment-preview-size">{formatBytes(attachment.file.size)}</span>
  {#if percent !== undefined}
    <span class="chat-attachment-preview-state">{percent}%</span>
  {/if}

  {#if percent !== undefined}
    <span
      class="chat-attachment-preview-loading"
      role="progressbar"
      aria-label="Uploading file"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span class="chat-attachment-preview-progress-bar" style:inline-size={`${percent}%`}></span>
    </span>
  {:else if attachment.status === 'pending' || attachment.status === 'uploading'}
    <span
      class="chat-attachment-preview-loading"
      role="status"
      aria-label={attachment.status === 'uploading' ? 'Uploading file' : 'Reading file'}
    >
      <span class="chat-attachment-preview-loading-bar"></span>
    </span>
  {/if}

  {#if action}
    {@render action()}
  {/if}
</span>

<style>
  .chat-attachment-preview {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1-5);
    min-inline-size: 0;
    max-inline-size: 100%;
    padding-block: var(--cinder-space-1);
    padding-inline: var(--cinder-space-2);
    overflow: hidden;
    border: 1px solid var(--cinder-border-control);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-raised);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    line-height: var(--cinder-leading-normal);
  }

  /* The type badge: the extension in capitals, in a quiet box. */
  .chat-attachment-preview-badge {
    flex: none;
    padding-inline: var(--cinder-space-1);
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    font-weight: var(--cinder-font-medium);
    letter-spacing: 0.02em;
  }

  /* The name truncates in the middle: the stem ellipsizes and the extension never shrinks. */
  .chat-attachment-preview-name {
    display: inline-flex;
    min-inline-size: 0;
    overflow: hidden;
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-medium);
    white-space: nowrap;
  }

  .chat-attachment-preview-stem {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-attachment-preview-extension {
    flex: none;
  }

  .chat-attachment-preview-state {
    flex: none;
    color: var(--cinder-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chat-attachment-preview-size {
    flex: none;
    color: var(--cinder-text-muted);
    white-space: nowrap;
  }

  /* A failed file keeps its chip; the colour says which one the reason beside it is about. */
  .chat-attachment-preview[data-error] {
    border-color: var(--cinder-status-danger-border);
  }

  .chat-attachment-preview[data-error] .chat-attachment-preview-badge {
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-muted);
  }

  .chat-attachment-preview-loading {
    position: absolute;
    inset-block-end: 0;
    inset-inline: 0;
    block-size: 2px;
    overflow: hidden;
    background: var(--cinder-surface-inset);
  }

  .chat-attachment-preview-progress-bar {
    display: block;
    block-size: 100%;
    background: var(--cinder-accent-solid);
  }

  .chat-attachment-preview-loading-bar {
    display: block;
    inline-size: 40%;
    block-size: 100%;
    background: var(--cinder-accent-solid);
    animation: loading-slide 1.2s ease-in-out infinite;
  }

  @keyframes loading-slide {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-attachment-preview-loading-bar {
      animation: none;
      inline-size: 100%;
    }
  }
</style>
