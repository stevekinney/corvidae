<script lang="ts">
  import { Container } from '@lostgradient/cinder';
</script>

<Container maxWidth="prose">
  <h1 class="h1 text-default">Reading column</h1>
  <p class="note text-muted">
    Container keeps long-form content at a comfortable measure and adds an inline gutter so text
    never touches the viewport edge.
  </p>
</Container>

<style>
  .h1 {
    font-size: var(--cinder-text-3xl);
    line-height: var(--cinder-leading-tight);
  }

  .note {
    font-size: var(--cinder-text-md);
  }
</style>
