<script lang="ts" module>
  export const title = 'Card with a muted header';
  export const description =
    'headerTone="muted" draws the header as an inset band over the rows beneath it.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<Card title="Needs attention" headingLevel={2} headerTone="muted" headerDivider padding="none">
  <p style="margin: 0; padding: var(--cinder-space-3) var(--cinder-space-4);">
    Storage is over its warning level
  </p>
</Card>
