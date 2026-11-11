<script lang="ts" module>
  export const title = 'Feature banner';
  export const description =
    'An announcement with glyph art, an indigo wash, a bold title, one muted line and trailing actions. It is a labelled region, not a status, and below 560px of its own width the actions drop under the words.';
</script>

<script lang="ts">
  import { Banner, Button } from '@lostgradient/cinder';
  import Sparkles from '@lucide/svelte/icons/sparkles';
</script>

<Banner variant="feature" title="Plan a night out with friends">
  Pick three bars and share one link; everyone votes before you go.
  {#snippet art()}
    <Sparkles aria-hidden="true" />
  {/snippet}
  {#snippet actions()}
    <Button variant="primary" size="sm" label="Start a plan" />
    <Button variant="ghost" size="sm" label="Not now" />
  {/snippet}
</Banner>
