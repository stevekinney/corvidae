<script lang="ts">
  import { default as Masonry } from '@lostgradient/masonry/components/masonry/index.ts';
</script>

<Masonry columns="3" gap="var(--cinder-space-4)" aria-label="Editorial cards">
  <article>
    <h2>Item 1</h2>
    <p>Short content.</p>
  </article>
  <article>
    <h2>Item 2</h2>
    <p>Longer content that occupies more vertical space.</p>
  </article>
  <article>
    <h2>Item 3</h2>
    <p>Medium content.</p>
  </article>
</Masonry>
