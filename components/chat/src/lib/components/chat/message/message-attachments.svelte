<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';
  import type { MultiModalContent } from '../conversation-model.ts';

  export type MessageAttachmentsProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
    /** Image parts from the message content */
    images: ReadonlyArray<MultiModalContent>;
    /** Lazy loading strategy */
    loading?: 'lazy' | 'eager';
    /** Called when an image loads */
    onimageload?: (index: number) => void;
    /** Called when an image fails to load */
    onimageerror?: (index: number, error: Event) => void;
    /** Additional CSS class */
    class?: string;
  };
</script>

<script lang="ts">
  import { classNames } from '../../../utilities/class-names.ts';
  import { mediaDisplayUrl } from '../builders.ts';
  import { Button, Maximize2, RotateCcw } from '@lostgradient/cinder';
  import { SvelteMap } from 'svelte/reactivity';
  import ImageLightbox from './image-lightbox.svelte';

  let {
    images,
    loading = 'lazy',
    onimageload,
    onimageerror,
    class: className,
    ...rest
  }: MessageAttachmentsProps = $props();

  // Filter to only image type content with valid URLs
  // Pre-compute URLs to ensure data-count matches rendered items
  const validImages = $derived(
    images
      .filter((item) => item.type === 'image')
      .map((image) => ({
        image,
        url: getImageUrlFromContent(image),
        dimensions: getImageDimensions(image),
      }))
      .filter((item) => item.url !== ''),
  );

  // Lightbox state
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);

  // Addresses whose image fired `error`. Keyed by address, not position, so a new address in the
  // same slot loads normally. A failed image shows a placeholder in its reserved box and leaves
  // the lightbox, whose navigation then skips it.
  let failedUrls = $state<string[]>([]);
  // How many times each address has been retried; part of the thumbnail key, so a retry mounts a
  // fresh `<img>` that requests the address again.
  const retryCounts = new SvelteMap<string, number>();

  // Pre-compute lightbox image array for the lightbox component: healthy images only.
  const lightboxEntries = $derived(
    validImages
      .map(({ image, url }, index) => ({ src: url, alt: getAltText(image, index + 1), index }))
      .filter((entry) => !failedUrls.includes(entry.src)),
  );
  const lightboxImages = $derived(lightboxEntries.map(({ src, alt }) => ({ src, alt })));

  /**
   * Extracts the image URL from an image content item.
   */
  function getImageUrlFromContent(image: MultiModalContent): string {
    if (image.type !== 'image') return '';
    // Only a source a browser can load has a display URL; other kinds (a managed
    // asset, a provider file) have none and are not rendered here.
    return mediaDisplayUrl(image) ?? '';
  }

  /**
   * Extracts alt text from an image content item.
   * Uses displayIndex for fallback text (1-based position in rendered list).
   */
  function getAltText(image: MultiModalContent, displayIndex: number): string {
    if (image.type !== 'image') return '';
    // ImageContent carries optional descriptive text used as the alt.
    if (image.alt) return image.alt;
    return `Image attachment ${displayIndex}`;
  }

  type ImageDimensions = { width: number; height: number } | undefined;

  function getImageDimensions(image: MultiModalContent): ImageDimensions {
    if (image.type !== 'image') return undefined;
    const width = image.metadata?.['width'];
    const height = image.metadata?.['height'];
    return typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
      ? { width, height }
      : undefined;
  }

  function handleLoad(index: number) {
    onimageload?.(index);
  }

  function handleError(index: number, url: string, event: Event) {
    if (!failedUrls.includes(url)) failedUrls = [...failedUrls, url];
    onimageerror?.(index, event);
  }

  function retryImage(url: string) {
    retryCounts.set(url, (retryCounts.get(url) ?? 0) + 1);
    failedUrls = failedUrls.filter((failed) => failed !== url);
  }

  // The lightbox holds healthy images only, so a thumbnail opens at its place among those.
  function openLightbox(index: number) {
    const healthyIndex = lightboxEntries.findIndex((entry) => entry.index === index);
    if (healthyIndex === -1) return;
    lightboxIndex = healthyIndex;
    lightboxOpen = true;
  }
</script>

<div
  class={classNames('message-attachments', className)}
  role="list"
  aria-label="Message attachments"
  data-count={validImages.length}
  {...rest}
>
  {#each validImages as { image, url, dimensions }, loopIndex (`${url}-${loopIndex}-${retryCounts.get(url) ?? 0}`)}
    {@const displayIndex = loopIndex + 1}
    {@const alt = getAltText(image, displayIndex)}
    {@const unavailable = failedUrls.includes(url)}
    <figure
      class="message-attachment"
      role="listitem"
      data-cinder-image-placeholder={dimensions ? undefined : ''}
      data-unavailable={unavailable ? '' : undefined}
      style={dimensions ? `aspect-ratio: ${dimensions.width} / ${dimensions.height}` : undefined}
    >
      {#if unavailable}
        <!-- The image failed: the same reserved box names what did not load and offers Retry,
             with no zoom and no native broken-image glyph. -->
        <div class="message-attachment-unavailable">
          <p class="message-attachment-unavailable-text" dir="auto">
            <span class="message-attachment-unavailable-name">{alt}</span>
            didn't load
          </p>
          <Button
            type="button"
            class="message-attachment-retry"
            size="xs"
            variant="secondary"
            aria-label={`Retry loading ${alt}`}
            onclick={() => retryImage(url)}
          >
            <RotateCcw class="cinder-icon-xs" aria-hidden="true" />
            Retry
          </Button>
        </div>
      {:else}
        <button
          type="button"
          class="message-attachment-button"
          aria-label={`View image: ${alt}`}
          title="Maximize image"
          onclick={() => openLightbox(loopIndex)}
        >
          <img
            src={url}
            {alt}
            {loading}
            decoding="async"
            class="message-attachment-image"
            width={dimensions?.width}
            height={dimensions?.height}
            onload={() => handleLoad(loopIndex)}
            onerror={(event) => handleError(loopIndex, url, event)}
          />
          <span class="message-attachment-maximize" aria-hidden="true">
            <Maximize2 class="cinder-icon-sm" />
          </span>
        </button>
        {#if alt && alt !== `Image attachment ${displayIndex}`}
          <figcaption class="cinder-sr-only">{alt}</figcaption>
        {/if}
      {/if}
    </figure>
  {/each}
</div>

<ImageLightbox images={lightboxImages} initialIndex={lightboxIndex} bind:open={lightboxOpen} />

<style>
  .message-attachments {
    display: grid;
    gap: var(--cinder-space-2);
    margin-top: var(--cinder-space-2);
  }

  /* Single images use their intrinsic ratio and stay within the message width. */
  .message-attachments[data-count='1'] {
    display: block;
    inline-size: fit-content;
    max-inline-size: min(32rem, 100%);
  }

  /* Two images: side by side */
  .message-attachments[data-count='2'] {
    grid-template-columns: repeat(2, 1fr);
  }

  /* Three or more: auto-fit grid */
  .message-attachments:not([data-count='1']):not([data-count='2']) {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .message-attachment {
    position: relative;
    margin: 0;
    min-block-size: 6rem;
    /* Reserve a decode-time box for ordinary image content. `contain` on the
     * image below preserves portrait/landscape proportions inside this box. */
    aspect-ratio: 4 / 3;
    max-block-size: 400px;
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
    background: var(--cinder-surface-inset);
  }

  .message-attachments[data-count='1'] .message-attachment[data-cinder-image-placeholder] {
    inline-size: min(20rem, 100%);
  }

  /* A failed image keeps its footprint as a dashed outline, so the layout does not move. */
  .message-attachment[data-unavailable] {
    border: 1px dashed var(--cinder-border-strong);
    background: transparent;
  }

  .message-attachments[data-count='1'] .message-attachment[data-unavailable] {
    inline-size: min(20rem, 100%);
    min-block-size: 6rem;
  }

  .message-attachment-unavailable {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--cinder-space-2);
    block-size: 100%;
    padding: var(--cinder-space-3);
    text-align: start;
  }

  .message-attachment-unavailable-text {
    margin: 0;
    max-inline-size: 100%;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    overflow-wrap: anywhere;
  }

  .message-attachment-unavailable-name {
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-semibold);
  }

  /* Button wrapper: removes chrome but keeps keyboard-operable behavior */
  .message-attachment-button {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--cinder-radius-md);
    cursor: zoom-in;
    overflow: hidden;
  }

  /* The button clips its image child with `overflow: hidden`; paint an INSET
     ring (Strategy B-inset) so the indicator sits on the thumbnail edge rather
     than being trimmed or doubling the surrounding grid gap. */
  .message-attachment-button:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: inset 0 0 0 var(--cinder-ring-width)
      var(--_cinder-message-attachment-button-ring, var(--cinder-ring-color));
  }

  @media (forced-colors: active) {
    .message-attachment-button:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: calc(var(--cinder-ring-width) * -1);
    }
  }

  .message-attachment-image {
    display: block;
    width: 100%;
    height: 100%;
    max-block-size: 400px;
    border-radius: var(--cinder-radius-md);
    /* Use contain to preserve full image content and avoid cropping */
    object-fit: contain;
    transition: opacity var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  .message-attachments[data-count='1'] .message-attachment,
  .message-attachments[data-count='1'] .message-attachment-image {
    max-block-size: 24rem;
  }

  .message-attachments[data-count='1'] .message-attachment {
    min-block-size: 0;
  }

  .message-attachment-maximize {
    position: absolute;
    inset-block-start: var(--cinder-space-2);
    inset-inline-end: var(--cinder-space-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: var(--cinder-touch-target-min);
    block-size: var(--cinder-touch-target-min);
    color: var(--cinder-text-default);
    background: color-mix(in oklch, var(--cinder-surface), transparent 12%);
    border-radius: var(--cinder-radius-full);
    opacity: 1;
    pointer-events: none;
    transition: opacity var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  .message-attachment-button:hover .message-attachment-maximize,
  .message-attachment-button:focus-visible .message-attachment-maximize {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .message-attachment-image,
    .message-attachment-maximize {
      transition: none;
    }
  }

  .message-attachment-button:hover .message-attachment-image {
    opacity: 0.85;
  }
</style>
