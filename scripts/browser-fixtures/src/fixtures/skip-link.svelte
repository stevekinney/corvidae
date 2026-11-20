<script lang="ts">
  import { SkipLink } from '@lostgradient/cinder';
</script>

<div class="example-content rounded-small padding-block-4 padding-inline-4">
  <SkipLink target="main" />

  <nav aria-label="Example navigation">
    <span class="margin-inline-end-4"><a href="#main">Home</a></span>
    <span class="margin-inline-end-4"><a href="#main">About</a></span>
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
</style>
