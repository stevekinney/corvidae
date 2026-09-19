<script lang="ts">
  import { SkipLink } from '@corvidae/cinder';
</script>

<div
  style="position: relative; min-height: 80px; border: 1px dashed var(--cinder-border); border-radius: 4px; padding: 1rem;"
>
  <SkipLink target="main" />

  <nav aria-label="Example navigation">
    <a href="#main" style="margin-right: 1rem;">Home</a>
    <a href="#main" style="margin-right: 1rem;">About</a>
    <a href="#main">Contact</a>
  </nav>

  <main id="main" style="margin-top: 1rem;">
    <p>Main content area. Focus lands here when the skip link is activated.</p>
  </main>
</div>
