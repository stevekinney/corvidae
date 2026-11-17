<script lang="ts" module>
  export const title = 'A tall section keeps every child';
  export const description =
    'The content is a block, so children that clip their overflow are never squeezed inside a flex or scroll parent.';
</script>

<script lang="ts">
  import { Section } from '@lostgradient/cinder';
</script>

<div style="display: flex; flex-direction: column; block-size: 12rem; overflow: auto;">
  <Section title="Tonight">
    {#each [1, 2, 3, 4, 5, 6] as number (number)}
      <p style="margin: 0; padding: 0.5rem 0; overflow: hidden;">Stop {number}</p>
    {/each}
  </Section>
</div>
