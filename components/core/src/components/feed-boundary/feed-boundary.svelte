<script lang="ts" module>
  export type { FeedBoundaryProps } from './feed-boundary.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { FeedBoundaryProps } from './feed-boundary.types.ts';

  let { label, datetime, timestamp, class: className, ...rest }: FeedBoundaryProps = $props();
</script>

<li {...rest} class={classNames('cinder-feed-boundary', className)}>
  <div class="cinder-feed-boundary__content" role="separator" aria-label={label}>
    {#if datetime}
      <time class="cinder-feed-boundary__time" {datetime} title={datetime}>
        {timestamp ?? datetime}
      </time>
    {:else if timestamp}
      <span class="cinder-feed-boundary__time">{timestamp}</span>
    {/if}
    <span>{label}</span>
  </div>
</li>
