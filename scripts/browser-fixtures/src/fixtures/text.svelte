<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<div
  data-testid="text-container"
  style="padding: 16px; color: var(--cinder-accent-text); background: var(--cinder-surface-raised);"
>
  <Text variant="h1">Heading 1</Text>
  <Text variant="h2">Heading 2</Text>
  <Text variant="h3">Heading 3</Text>
  <Text variant="h4">Heading 4</Text>
  <Text variant="h5">Heading 5</Text>
  <Text>Body text</Text>
  <Text variant="caption">Caption text</Text>
</div>

<div data-testid="text-themed-container" style="padding: 16px; color: var(--cinder-text-muted);">
  <Text variant="h2">Themed heading</Text>
  <Text variant="caption">Themed caption</Text>
</div>
