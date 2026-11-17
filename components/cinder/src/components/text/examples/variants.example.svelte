<script lang="ts" module>
  export const title = 'Typography variants';
  export const description =
    'Each variant renders its matching element: h1 to h5 headings, and paragraphs for caption and body.';
</script>

<script lang="ts">
  import { Text } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: var(--cinder-space-3);">
  <Text variant="h1">Heading 1</Text>
  <Text variant="h2">Heading 2</Text>
  <Text variant="h3">Heading 3</Text>
  <Text variant="h4">Heading 4</Text>
  <Text variant="h5">Heading 5</Text>
  <Text>Body text is the default variant.</Text>
  <Text variant="caption">Caption text for supporting detail.</Text>
</div>
