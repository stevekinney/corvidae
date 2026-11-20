<script lang="ts">
  import { SkipLink } from '@lostgradient/cinder';
</script>

<div class="example-content rounded-small padding-block-4 padding-inline-4">
  <SkipLink target="main" />

  <nav class="example-navigation" aria-label="Example navigation">
    <a href="#main">Home</a>
    <a href="#main">About</a>
    <a href="#main">Contact</a>
  </nav>

  <main id="main" class="margin-block-start-4">
    <p>Main content area. Focus lands here when the skip link is activated.</p>
  </main>
</div>

<style>
  .example-content {
    position: relative;
    min-height: var(--cinder-space-20);
    border: 1px dashed var(--cinder-border);
  }

  .example-navigation :global(a + a) {
    margin-inline-start: var(--cinder-space-4);
  }
</style>
