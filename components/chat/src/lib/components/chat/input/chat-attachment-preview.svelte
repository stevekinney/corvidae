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
  import { Paperclip } from '@lostgradient/cinder';

  let { attachment, class: className, action }: ChatAttachmentPreviewProps = $props();
</script>

<!--
  An attached file is a chip: a paperclip, the file's name and its size, and an optional control
  at its end. A file that failed keeps its chip, in the danger colour; its reason is drawn beside
  it by the composer.
-->
<span
  class={classNames('chat-attachment-preview', className)}
  data-kind={attachment.kind}
  data-state={attachment.status}
  data-error={attachment.status === 'error' || undefined}
  data-pending={attachment.status === 'pending' || attachment.status === 'uploading' || undefined}
>
  <Paperclip class="chat-attachment-preview-icon cinder-icon-xs" aria-hidden="true" />
  <span class="chat-attachment-preview-name" title={attachment.file.name}
    >{attachment.file.name}</span
  >
  <span class="chat-attachment-preview-size">{formatBytes(attachment.file.size)}</span>

  {#if attachment.status === 'pending' || attachment.status === 'uploading'}
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

  .chat-attachment-preview :global(.chat-attachment-preview-icon) {
    flex: none;
    color: var(--cinder-text-muted);
  }

  .chat-attachment-preview-name {
    min-inline-size: 0;
    overflow: hidden;
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-medium);
    text-overflow: ellipsis;
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

  .chat-attachment-preview[data-error] :global(.chat-attachment-preview-icon) {
    color: var(--cinder-status-danger-text);
  }

  /* Pending: dim non-text elements only to preserve text contrast. */
  .chat-attachment-preview[data-pending] :global(.chat-attachment-preview-icon) {
    opacity: 0.6;
  }

  .chat-attachment-preview-loading {
    position: absolute;
    inset-block-end: 0;
    inset-inline: 0;
    block-size: 2px;
    overflow: hidden;
    background: var(--cinder-surface-inset);
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
