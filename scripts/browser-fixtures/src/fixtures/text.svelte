<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<div
  data-testid="text-container"
  class="text-container-layout padding-block-4 padding-inline-4 background-surface-raised"
>
  <Text variant="h1">Heading 1</Text>
  <Text variant="h2">Heading 2</Text>
  <Text variant="h3">Heading 3</Text>
  <Text variant="h4">Heading 4</Text>
  <Text variant="h5">Heading 5</Text>
  <Text>Body text</Text>
  <Text variant="caption">Caption text</Text>
</div>

<div data-testid="text-themed-container" class="padding-block-4 padding-inline-4 text-muted">
  <Text variant="h2">Themed heading</Text>
  <Text variant="caption">Themed caption</Text>
</div>

<style>
  .text-container-layout {
    color: var(--cinder-accent-text);
  }
</style>
