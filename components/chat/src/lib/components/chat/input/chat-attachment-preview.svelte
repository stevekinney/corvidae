<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ChatAttachment } from './chat-attachment.ts';
  import type { ChatLabels } from '../chat-labels.ts';

  export interface ChatAttachmentPreviewProps {
    attachment: ChatAttachment;
    class?: string;
    /**
     * What activating the chip's main area does: retries a failed upload, or shows why one of
     * several failed. Without it the main area is plain content.
     */
    onactivate?: (() => void) | undefined;
    /** The accessible name of the main area while it is a control. */
    activateLabel?: string | undefined;
    /** Whether the chip is the failed file the line under the strip is explaining. */
    picked?: boolean | undefined;
    /** A control drawn at the end of the chip, inside its border, such as Remove. */
    action?: Snippet | undefined;
    labels?: ChatLabels;
  }
</script>

<script lang="ts">
  import {
    File,
    FileArchive,
    FileAudio,
    FileCode,
    FileImage,
    FileSpreadsheet,
    FileText,
    FileVideo,
    Progress,
    RotateCcw,
    TriangleAlert,
  } from '@lostgradient/cinder';
  import { classNames } from '../../../utilities/class-names.ts';
  import { DEFAULT_CHAT_LABELS } from '../chat-labels.ts';
  import { attachmentGlyph, canRetry, splitFileName, uploadPercent } from './attachment-tile.ts';

  let {
    attachment,
    class: className,
    onactivate,
    activateLabel,
    picked,
    action,
    labels = DEFAULT_CHAT_LABELS,
  }: ChatAttachmentPreviewProps = $props();

  const glyph = $derived(
    attachmentGlyph(attachment.file.name, attachment.file.type, attachment.kind),
  );
  const GLYPHS = {
    image: FileImage,
    document: FileText,
    spreadsheet: FileSpreadsheet,
    archive: FileArchive,
    audio: FileAudio,
    video: FileVideo,
    code: FileCode,
    file: File,
  } as const;
  const FileGlyph = $derived(GLYPHS[glyph]);
  const parts = $derived(splitFileName(attachment.file.name));
  const percent = $derived(
    attachment.status === 'uploading' ? uploadPercent(attachment.progress) : undefined,
  );
  const busy = $derived(attachment.status === 'pending' || attachment.status === 'uploading');
  const failed = $derived(attachment.status === 'error');
</script>

<!--
  An attached file is a chip: the glyph of its kind of file, its name (the stem shortens at its end
  and the extension stays whole), and an optional control at its end. While it uploads a ring takes
  the glyph's place; a file that failed has a danger outline and a retry or a warning glyph.
  Everything a failure says goes in the line under the strip, never in the chip.
-->
{#snippet content()}
  <span class="chat-attachment-preview-glyph" aria-hidden={busy ? undefined : 'true'}>
    {#if busy}
      <Progress
        variant="ring"
        size="xs"
        {...percent === undefined ? {} : { value: percent }}
        ariaLabel={attachment.status === 'uploading' ? labels.uploadingFile : labels.readingFile}
      />
    {:else if failed && canRetry(attachment)}
      <RotateCcw class="cinder-icon-sm" aria-hidden="true" />
    {:else if failed}
      <TriangleAlert class="cinder-icon-sm" aria-hidden="true" />
    {:else}
      <FileGlyph class="cinder-icon-sm" aria-hidden="true" />
    {/if}
  </span>
  <span class="chat-attachment-preview-name" dir="auto"
    ><span class="chat-attachment-preview-stem">{parts.stem}</span><span
      class="chat-attachment-preview-extension">{parts.extension}</span
    ></span
  >
{/snippet}
<span
  class={classNames('chat-attachment-preview', className)}
  data-kind={attachment.kind}
  data-glyph={glyph}
  data-state={attachment.status}
  data-error={failed || undefined}
  data-failure-kind={failed ? (attachment.failureKind ?? 'unknown') : undefined}
  data-picked={picked || undefined}
  data-pending={busy || undefined}
  title={failed && attachment.error !== undefined
    ? `${attachment.file.name}. ${attachment.error}`
    : attachment.file.name}
>
  {#if onactivate}
    <button
      type="button"
      class="chat-attachment-preview-main"
      aria-label={activateLabel}
      aria-pressed={picked === undefined ? undefined : picked}
      onclick={onactivate}
    >
      {@render content()}
    </button>
  {:else}
    <span class="chat-attachment-preview-main">{@render content()}</span>
  {/if}
  {#if action}
    <span class="chat-attachment-preview-actions">{@render action()}</span>
  {/if}
</span>

<style>
  /* One height for every chip, whatever it holds: a glyph, a ring, or a retry. */
  .chat-attachment-preview {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    min-inline-size: 0;
    block-size: var(--_cinder-painted-height-sm, 1.75rem);
    box-sizing: border-box;
    padding-inline-start: var(--cinder-space-2);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-raised);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    line-height: var(--cinder-leading-normal);
  }

  .chat-attachment-preview-main {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--cinder-space-1-5, 0.375rem);
    min-inline-size: 0;
    block-size: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
  }

  button.chat-attachment-preview-main {
    cursor: pointer;
    border-radius: var(--cinder-radius-sm);
  }

  /* The inset recipe: the ring sits inside the chip's own border, where the strip cannot clip it. */
  button.chat-attachment-preview-main:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color);
  }

  /* On a touch screen the chip paints compact and its main area reaches 44px tall by a positioned
   * pseudo-element that takes no layout. */
  @media (any-pointer: coarse) {
    button.chat-attachment-preview-main {
      position: relative;
    }

    button.chat-attachment-preview-main::before {
      content: '';
      position: absolute;
      inset-inline: 0;
      inset-block: min(0px, calc((100% - var(--cinder-touch-target-min, 44px)) / 2));
    }
  }

  @media (forced-colors: active) {
    button.chat-attachment-preview-main:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: calc(var(--cinder-ring-width) * -1);
    }
  }

  /* The glyph is 1rem, never taller than the name's line, and is centred on it by the row. */
  .chat-attachment-preview-glyph {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    inline-size: 1rem;
    block-size: 1rem;
    color: var(--cinder-text-muted);
  }

  .chat-attachment-preview-glyph :global(.cinder-progress) {
    display: flex;
  }

  /* The stem shortens at its end; the extension never shrinks, so "quarterly-rep….pdf" reads. */
  .chat-attachment-preview-name {
    display: flex;
    flex: 1 1 auto;
    min-inline-size: 0;
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-medium);
    white-space: nowrap;
  }

  .chat-attachment-preview-stem {
    flex: 0 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-attachment-preview-extension {
    flex: none;
  }

  .chat-attachment-preview-actions {
    display: inline-flex;
    flex: none;
    align-items: center;
    margin-inline-start: var(--cinder-space-1);
    padding-inline-end: var(--cinder-space-0-5, 0.125rem);
  }

  /* A failed file keeps its chip and gains the danger outline; its glyph is the only other change. */
  .chat-attachment-preview[data-error] {
    border-color: var(--cinder-status-danger-border, var(--cinder-status-danger-text));
  }

  .chat-attachment-preview[data-error] .chat-attachment-preview-glyph {
    color: var(--cinder-status-danger-text);
  }

  .chat-attachment-preview[data-failure-kind='too-large'] .chat-attachment-preview-glyph,
  .chat-attachment-preview[data-failure-kind='unsupported-type'] .chat-attachment-preview-glyph {
    color: var(--cinder-status-warning-text);
  }

  .chat-attachment-preview[data-picked] {
    background: var(--cinder-status-danger-background, var(--cinder-surface-inset));
  }
</style>
