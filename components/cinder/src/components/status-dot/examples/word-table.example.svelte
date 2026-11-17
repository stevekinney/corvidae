<script lang="ts" module>
  export const title = 'Status words';
  export const description =
    'Every status word in the word-to-tone table, one tone per word. A page passes the word and never picks a tone; a qualifier after a comma rides along, except that a qualified Done is always neutral.';
</script>

<script lang="ts">
  import { StatusDot, statusDotWordTones } from '@lostgradient/cinder';

  const words = Object.keys(statusDotWordTones) as (keyof typeof statusDotWordTones)[];
</script>

<div class="example-preview-column">
  <div
    style="display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--cinder-space-2) var(--cinder-space-4);"
  >
    {#each words as word (word)}
      <StatusDot {word} size="sm" />
    {/each}
  </div>
  <div class="example-preview-row">
    <StatusDot word="Running, checking the result" size="sm" />
    <StatusDot word="Missed runs, 4" size="sm" />
    <StatusDot word="Done, refund not issued" size="sm" />
  </div>
</div>
