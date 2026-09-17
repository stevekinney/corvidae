<script lang="ts">
  import Basic from './mega-menu/basic.svelte';
</script>

<Basic />
<section id="accessibility" aria-label="Accessibility shortcuts">
  <ul class="dx-keys__key-list">
    <li><span class="cinder-kbd">ArrowDown</span></li>
    {#each ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'Escape', 'Tab'] as key}
      <li class="dx-keys__alternative">
        <span class="dx-keys__separator">/</span>
        <span class="cinder-kbd">{key}</span>
      </li>
    {/each}
  </ul>
</section>
