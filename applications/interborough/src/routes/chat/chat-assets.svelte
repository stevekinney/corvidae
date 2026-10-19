<script lang="ts">
  /**
   * The managed assets on one chat row, shown by kind (COR-1548): an image with Cinder `Image`,
   * audio with a native `<audio>` driven by Cinder `MediaControls` (`AudioPlayer`), video with a
   * native `<video>`, and anything else as a Cinder `Link` that downloads it. Every address is the
   * Bureau's content route; the bytes are never read by the page.
   */
  import { AudioPlayer, Image, Link, VideoPlayer } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { assetContentPath } from '../../lib/bureau-assets.ts';
  import { kindOf, type ChatAsset } from './chat-assets.ts';

  interface ChatAssetsProps {
    assets: readonly ChatAsset[];
    /** Which side of the transcript the row is on, so the assets sit under their message. */
    role: 'user' | 'assistant';
  }

  let { assets, role }: ChatAssetsProps = $props();
</script>

{#if assets.length > 0}
  <ul class="weft-chat-assets" data-role={role} aria-label={CHAT_COPY.assets.listLabel}>
    {#each assets as asset, index (asset.assetId)}
      {@const kind = kindOf(asset.mediaType)}
      {@const source = assetContentPath(asset.assetId)}
      <li class="weft-chat-asset" data-kind={kind} data-asset-id={asset.assetId}>
        {#if kind === 'image'}
          <Image
            src={source}
            alt={CHAT_COPY.assets.image(index + 1)}
            loading="eager"
            fit="contain"
            size="large"
          />
        {:else if kind === 'audio'}
          <AudioPlayer src={source} label={CHAT_COPY.assets.audio(index + 1)} />
        {:else if kind === 'video'}
          <VideoPlayer src={source} label={CHAT_COPY.assets.video(index + 1)} />
        {:else}
          <Link href={source} download>{CHAT_COPY.assets.download(asset.mediaType)}</Link>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .weft-chat-assets {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-chat-assets[data-role='user'] {
    align-items: flex-end;
  }

  .weft-chat-assets[data-role='assistant'] {
    align-items: flex-start;
  }

  .weft-chat-asset {
    max-width: min(100%, 24rem);
  }
</style>
