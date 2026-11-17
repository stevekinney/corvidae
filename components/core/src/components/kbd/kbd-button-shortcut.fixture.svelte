<script lang="ts">
  import Button from '../button/button.svelte';
  import type { ButtonSize, ButtonVariant } from '../button/button.types.ts';

  // Every variant the shortcut chip must hold on, at every size from small to large, each beside
  // the same button without a shortcut so a test can compare their heights.
  const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
  const sizes: ButtonSize[] = ['sm', 'md', 'lg'];
</script>

<div class="button-shortcut">
  {#each variants as variant (variant)}
    {#each sizes as size (size)}
      <div class="button-shortcut__row" data-testid="{variant}-{size}">
        <Button {variant} {size} label="Save" shortcut={['Ctrl', 'S']} />
        <Button {variant} {size} label="Save" />
      </div>
    {/each}
  {/each}
  <div class="button-shortcut__row" data-testid="disabled-md">
    <Button variant="primary" label="Save" shortcut="S" disabled />
    <Button variant="primary" label="Save" disabled />
  </div>
</div>

<style>
  .button-shortcut {
    display: grid;
    grid-template-columns: repeat(3, max-content);
    gap: 0.75rem 1.5rem;
    padding: 1rem;
  }

  .button-shortcut__row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
</style>
