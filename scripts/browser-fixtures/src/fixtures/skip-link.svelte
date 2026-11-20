<script lang="ts">
  import { SkipLink } from '@lostgradient/cinder';
</script>

<div
  style="position: relative; min-height: var(--cinder-space-20); border: 1px dashed var(--cinder-border); border-radius: var(--cinder-radius-sm); padding: var(--cinder-space-4);"
>
  <SkipLink target="main" />

  <nav aria-label="Example navigation">
    <a href="#main" style="margin-right: var(--cinder-space-4);">Home</a>
    <a href="#main" style="margin-right: var(--cinder-space-4);">About</a>
    <a href="#main">Contact</a>
  </nav>

  <main id="main" style="margin-top: var(--cinder-space-4);">
    <p>Main content area. Focus lands here when the skip link is activated.</p>
  </main>
</div>
