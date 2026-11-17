<script lang="ts" module>
  export const title = 'A phone detail page';
  export const description =
    'Back, the page title at 20px bold, then icon actions with tooltips, pinned over the content as it scrolls. The bar is translucent and draws no rule.';
</script>

<script lang="ts">
  import { AppBar } from '@lostgradient/cinder';
  import Share from '@lucide/svelte/icons/share';
  import Star from '@lucide/svelte/icons/star';
</script>

{#snippet shareIcon()}<Share class="cinder-icon-md" aria-hidden="true" />{/snippet}
{#snippet saveIcon()}<Star class="cinder-icon-md" aria-hidden="true" />{/snippet}

<div style="max-inline-size: 375px; block-size: 20rem; overflow: auto;">
  <AppBar
    title="Death & Co"
    headingLevel={2}
    back={{ onclick: () => {} }}
    actions={[
      { label: 'Share', icon: shareIcon, onclick: () => {} },
      { label: 'Save', icon: saveIcon, onclick: () => {} },
    ]}
  />
  <p style="padding: 1rem;">
    Cocktail bar in LoDo. Happy hour runs from four to six on weekdays, with half-price classics and
    a short bar menu. Scroll to see the content pass under the bar.
  </p>
  <p style="padding: 1rem;">
    The bar stays pinned at the top of the scrolling area while the page moves under it.
  </p>
  <p style="padding: 1rem;">It is opaque when the person asks for less transparency.</p>
</div>
