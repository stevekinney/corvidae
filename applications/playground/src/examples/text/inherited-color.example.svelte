<script lang="ts" module>
  export const title = 'Inherited color';
  export const description =
    'Text takes its color from the container, so it follows any surface it is placed on.';
</script>

<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<div
  style="padding: var(--cinder-space-4); background: var(--cinder-accent-solid); color: var(--cinder-text-inverse);"
>
  <Text variant="h3">Inherits from the container</Text>
  <Text>The color comes from the surrounding element.</Text>
</div>
