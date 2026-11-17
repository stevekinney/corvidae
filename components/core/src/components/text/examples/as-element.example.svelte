<script lang="ts" module>
  export const title = 'Overriding the element';
  export const description =
    'The as prop swaps the rendered element while keeping the variant style, for example a visually large h2 inside a section.';
</script>

<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<article style="display: grid; gap: var(--cinder-space-2);">
  <Text variant="h1" as="h2">Styled as h1, rendered as h2</Text>
  <Text variant="caption" as="span">Inline caption</Text>
</article>
